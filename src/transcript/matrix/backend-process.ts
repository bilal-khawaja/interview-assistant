import type { Socket, Subprocess } from 'bun';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Pipe {
  upstream?: Socket<Pipe>;
  client?: Socket<Pipe>;
  toUpstream: Uint8Array[];
  toClient: Uint8Array[];
}

/**
 * The real backend (`bun run scripts/server.ts`) as a child process, behind a TCP proxy the
 * test can sever. The proxy keeps one address across crashes and restarts, so a client sees
 * what it would see on a real network: refused or cut connections, then the server again.
 */
export class BackendProcess {
  private proc: Subprocess | null = null;
  private upstreamPort = 0;
  private proxy: ReturnType<typeof Bun.listen<Pipe>> | null = null;
  private readonly pipes = new Set<Socket<Pipe>>();
  private output = '';

  constructor(
    private readonly dir: string,
    private readonly env: Record<string, string>,
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.proxy!.port}`;
  }

  /** The backend's own address, bypassing the proxy. */
  get directUrl(): string {
    return `http://127.0.0.1:${this.upstreamPort}`;
  }

  /** The tail of what the backend printed, for failure messages. */
  get logs(): string {
    return this.output;
  }

  get pid(): number {
    return this.proc!.pid;
  }

  async start(): Promise<void> {
    if (this.proc) return;
    if (this.upstreamPort === 0) this.upstreamPort = await freePort();
    this.proxy ??= this.listen();
    this.output = '';
    const proc = Bun.spawn([process.execPath, 'run', 'scripts/server.ts'], {
      cwd: this.dir,
      env: { ...process.env, ...this.env, PORT: String(this.upstreamPort) },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    this.proc = proc;
    void this.collect(proc.stdout as ReadableStream<Uint8Array>);
    void this.collect(proc.stderr as ReadableStream<Uint8Array>);
    void proc.exited.then(() => {
      if (this.proc === proc) this.proc = null;
    });

    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (this.proc !== proc) throw new Error(`backend exited while starting:\n${this.output}`);
      const ok = await fetch(`http://127.0.0.1:${this.upstreamPort}/healthz`)
        .then((response) => response.ok)
        .catch(() => false);
      if (ok) return;
      await sleep(200);
    }
    proc.kill();
    throw new Error(`backend did not become healthy:\n${this.output}`);
  }

  /** A crash: the process dies with no chance to clean up. */
  kill(): void {
    const proc = this.proc;
    this.proc = null;
    proc?.kill();
  }

  /** Cuts every connection between clients and the backend, leaving the backend running. */
  dropConnections(): void {
    for (const pipe of [...this.pipes]) pipe.terminate();
    this.pipes.clear();
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    this.kill();
    await proc?.exited.catch(() => undefined);
    this.proxy?.stop(true);
    this.proxy = null;
  }

  private async collect(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    try {
      let partial = '';
      for await (const chunk of stream) {
        const lines = (partial + decoder.decode(chunk)).split(/\r?\n/);
        partial = lines.pop() ?? '';
        // Chat-side noise (the OpenAI key) would bury the meeting lines that explain a failure.
        const kept = lines.filter((line) => /^(SERVER|MEETING|LIVE|DEEPGRAM|APPENDER|SPOOL|BACKLOG)\b/.test(line));
        if (kept.length) this.output = `${this.output}${kept.join('\n')}\n`.slice(-8_000);
      }
    } catch {
      // the process went away
    }
  }

  private listen() {
    const pipes = this.pipes;
    const upstreamPort = () => this.upstreamPort;
    return Bun.listen<Pipe>({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        open(client) {
          const pipe: Pipe = { toUpstream: [], toClient: [] };
          client.data = pipe;
          pipe.client = client;
          pipes.add(client);
          void Bun.connect<Pipe>({
            hostname: '127.0.0.1',
            port: upstreamPort(),
            data: pipe,
            socket: {
              open(up) {
                pipe.upstream = up;
                pipes.add(up);
                flush(up, pipe.toUpstream);
              },
              data(_up, chunk) {
                pipe.toClient.push(chunk.slice());
                flush(client, pipe.toClient);
              },
              drain: (up) => flush(up, pipe.toUpstream),
              close(up) {
                pipes.delete(up);
                client.end();
              },
              error(up) {
                pipes.delete(up);
                client.end();
              },
              connectError: () => client.end(),
            },
          }).catch(() => client.end());
        },
        data(client, chunk) {
          const pipe = client.data;
          pipe.toUpstream.push(chunk.slice());
          if (pipe.upstream) flush(pipe.upstream, pipe.toUpstream);
        },
        drain: (client) => flush(client, client.data.toClient),
        close(client) {
          pipes.delete(client);
          client.data.upstream?.end();
        },
        error(client) {
          pipes.delete(client);
          client.data.upstream?.end();
        },
      },
    });
  }
}

/** socket.write may take only part of a chunk; the rest waits for the next drain. */
function flush(socket: Socket<Pipe>, queue: Uint8Array[]): void {
  while (queue.length > 0) {
    const chunk = queue[0]!;
    const written = socket.write(chunk);
    if (written < chunk.length) {
      queue[0] = chunk.subarray(Math.max(0, written));
      return;
    }
    queue.shift();
  }
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const port = probe.port!;
  await probe.stop(true);
  return port;
}

/** Resident memory of a process in MB, or 0 when it cannot be read. */
export function rssMb(pid: number): number {
  const result =
    process.platform === 'win32'
      ? Bun.spawnSync(['tasklist', '/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
      : Bun.spawnSync(['ps', '-o', 'rss=', '-p', String(pid)]);
  const text = result.stdout.toString();
  if (process.platform === 'win32') {
    const kb = text.trim().split('","').at(-1)?.replace(/[^0-9]/g, '');
    return kb ? Math.round(Number(kb) / 1024) : 0;
  }
  const kb = Number(text.trim());
  return Number.isFinite(kb) ? Math.round(kb / 1024) : 0;
}

export async function dockerCommand(...args: string[]): Promise<void> {
  const proc = Bun.spawn(['docker', ...args], { stdout: 'ignore', stderr: 'pipe' });
  if ((await proc.exited) !== 0) {
    throw new Error(`docker ${args.join(' ')}: ${await new Response(proc.stderr as ReadableStream).text()}`);
  }
}
