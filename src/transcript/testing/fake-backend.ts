// Test double for backend/server: the same REST routes and WebSocket frames, in memory.
// Bun-only; excluded from the app's tsconfig.
import type { Meeting, TranscriptSegment } from '../../types/transcript';

type SocketData = { kind: 'stream'; meetingId: string; after: number } | { kind: 'audio'; meetingId: string };

export class FakeBackend {
  readonly segments = new Map<string, TranscriptSegment[]>();
  readonly meetings = new Map<string, Meeting>();
  readonly audioFrames: Uint8Array[] = [];
  readonly streams = new Set<Bun.ServerWebSocket<SocketData>>();
  readonly audios = new Set<Bun.ServerWebSocket<SocketData>>();
  heartbeatMs = 60_000;
  /** Sent right after "ready" on every stream connection (tests inject frames here). */
  afterReady: ((ws: Bun.ServerWebSocket<SocketData>) => void) | null = null;
  ends = 0;
  starts: unknown[] = [];
  refuseStreams = false;
  /** Stream sockets opened, with the resume point each asked for. */
  streamOpens: { meetingId: string; after: number }[] = [];
  private server!: ReturnType<typeof Bun.serve>;
  private counter = 0;
  private port = 0;

  get url(): string {
    return `http://localhost:${this.port}`;
  }

  start(port = 0): this {
    this.server = Bun.serve<SocketData>({
      port,
      fetch: (req, server) => this.handle(req, server),
      websocket: {
        open: (ws) => this.onOpen(ws),
        message: (ws, message) => {
          if (ws.data.kind === 'audio' && typeof message !== 'string') {
            this.audioFrames.push(new Uint8Array(message));
          }
        },
        close: (ws) => {
          this.streams.delete(ws);
          this.audios.delete(ws);
        },
      },
    });
    this.port = this.server.port as number;
    return this;
  }

  async stop(): Promise<void> {
    await this.server.stop(true);
  }

  /** Closes the listener and drops every open socket, as if the backend process died. */
  async kill(): Promise<number> {
    const port = this.port;
    for (const ws of [...this.streams, ...this.audios]) ws.close(1011, 'killed');
    await this.server.stop(true);
    return port;
  }

  addMeeting(partial: Partial<Meeting> = {}): Meeting {
    const id = partial.id ?? `00000000-0000-4000-8000-${String(++this.counter).padStart(12, '0')}`;
    const meeting: Meeting = {
      id,
      title: 'test',
      status: 'live',
      source: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      createdAt: new Date().toISOString(),
      ...partial,
    };
    this.meetings.set(id, meeting);
    if (!this.segments.has(id)) this.segments.set(id, []);
    return meeting;
  }

  /** Appends a segment and sends it to every open stream of the meeting. */
  push(meetingId: string, text: string, extra: Partial<TranscriptSegment> = {}): TranscriptSegment {
    const log = this.segments.get(meetingId)!;
    const seq = log.length + 1;
    const segment: TranscriptSegment = {
      seq,
      text,
      startMs: seq * 1000,
      endMs: seq * 1000 + 900,
      source: 'deepgram',
      speakerKey: 'spk_0',
      speaker: null,
      createdAt: new Date().toISOString(),
      ...extra,
    };
    log.push(segment);
    for (const ws of this.streams) {
      if (ws.data.kind === 'stream' && ws.data.meetingId === meetingId) {
        ws.send(JSON.stringify({ type: 'segment', ...segment }));
      }
    }
    return segment;
  }

  end(meetingId: string): void {
    const meeting = this.meetings.get(meetingId);
    if (meeting) this.meetings.set(meetingId, { ...meeting, status: 'ended', source: null, endedAt: new Date().toISOString() });
  }

  dropStreams(code = 1006): void {
    for (const ws of this.streams) ws.close(code, 'dropped');
  }

  broadcast(frame: unknown): void {
    for (const ws of this.streams) ws.send(JSON.stringify(frame));
  }

  private onOpen(ws: Bun.ServerWebSocket<SocketData>): void {
    if (ws.data.kind === 'audio') {
      this.audios.add(ws);
      return;
    }
    const { meetingId, after } = ws.data;
    this.streamOpens.push({ meetingId, after });
    const log = this.segments.get(meetingId) ?? [];
    if (after > log.length) {
      ws.send(JSON.stringify({ type: 'error', code: 'cursor_ahead', message: `after=${after} is beyond the log head ${log.length}` }));
      ws.close(4409, 'cursor ahead of head');
      return;
    }
    ws.send(JSON.stringify({ type: 'ready', stream: 'transcript', meetingId, after, head: log.length, heartbeatMs: this.heartbeatMs }));
    this.streams.add(ws);
    for (const segment of log.slice(after)) ws.send(JSON.stringify({ type: 'segment', ...segment }));
    this.afterReady?.(ws);
  }

  private async handle(req: Request, server: Bun.Server<SocketData>): Promise<Response | undefined> {
    const url = new URL(req.url);
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    const parts = url.pathname.split('/').filter(Boolean);

    if (url.pathname === '/healthz') return json({ ok: true });

    if (parts[0] === 'meetings') {
      const id = parts[1];
      if (!id && req.method === 'GET') {
        return json({ meetings: [...this.meetings.values()].reverse() });
      }
      if (!id && req.method === 'POST') {
        const body = await req.json();
        this.starts.push(body);
        const live = [...this.meetings.values()].find((m) => m.status === 'live');
        if (live) return json({ error: 'a meeting is already live', meetingId: live.id }, 409);
        return json(this.addMeeting({ source: (body as { source: Meeting['source'] }).source }), 201);
      }
      const meeting = id ? this.meetings.get(id) : undefined;
      if (id && !parts[2] && req.method === 'GET') {
        return meeting ? json(meeting) : json({ error: 'not found' }, 404);
      }
      if (parts[2] === 'end' && req.method === 'POST') {
        if (!meeting) return json({ error: 'not found' }, 404);
        this.ends++;
        this.end(id!);
        return json(this.meetings.get(id!));
      }
      if (parts[2] === 'stream') {
        if (this.refuseStreams) return json({ error: 'unavailable' }, 503);
        if (!meeting) return json({ error: 'not found' }, 404);
        const after = Number(url.searchParams.get('after') ?? '0');
        if (server.upgrade(req, { data: { kind: 'stream', meetingId: id!, after } })) return undefined;
        return json({ error: 'upgrade failed' }, 400);
      }
      if (parts[2] === 'audio') {
        if (!meeting || meeting.status !== 'live') return json({ error: 'meeting is not taking live audio' }, 409);
        if (server.upgrade(req, { data: { kind: 'audio', meetingId: id! } })) return undefined;
        return json({ error: 'upgrade failed' }, 400);
      }
    }
    return json({ error: 'not found' }, 404);
  }
}

export async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}
