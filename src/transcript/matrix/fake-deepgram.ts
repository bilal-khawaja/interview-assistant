import type { Server, ServerWebSocket } from 'bun';

/** 16 kHz mono 16-bit PCM: one second of audio. */
const BYTES_PER_SECOND = 32_000;

interface Conn {
  bytes: number;
  seconds: number;
}

/**
 * Stands in for Deepgram's live endpoint. Every second of audio it receives comes back as one
 * final result, so a transcript grows at the rate the microphone talks. It can be told to
 * drop every connection or to refuse new ones, which is how the matrix breaks Deepgram.
 */
export class FakeDeepgram {
  /** While true, new connections are refused with a 503. */
  refuse = false;
  /** Every second of audio received, across connections. */
  audioSeconds = 0;
  /** Connections accepted so far. */
  connections = 0;
  private server: Server<Conn> | null = null;
  private readonly sockets = new Set<ServerWebSocket<Conn>>();
  private utterances = 0;

  get url(): string {
    return `ws://127.0.0.1:${this.server!.port}/v1/listen`;
  }

  async start(): Promise<void> {
    const self = this;
    this.server = Bun.serve<Conn>({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request, server) {
        if (self.refuse) return new Response('unavailable', { status: 503 });
        const upgraded = server.upgrade(request, {
          data: { bytes: 0, seconds: 0 },
          headers: { 'sec-websocket-protocol': 'token' },
        });
        return upgraded ? undefined : new Response('websocket only', { status: 400 });
      },
      websocket: {
        open(ws) {
          self.connections++;
          self.sockets.add(ws);
        },
        close: (ws) => void self.sockets.delete(ws),
        message(ws, message) {
          if (typeof message === 'string') {
            if (message.includes('CloseStream')) ws.close(1000);
            return;
          }
          ws.data.bytes += message.byteLength;
          while (ws.data.bytes >= BYTES_PER_SECOND) {
            ws.data.bytes -= BYTES_PER_SECOND;
            self.audioSeconds++;
            ws.send(self.result(ws.data.seconds++));
          }
        },
      },
    });
  }

  /** Cuts every open connection, as a network failure would. */
  dropAll(): void {
    for (const socket of this.sockets) socket.close(1011, 'matrix drop');
  }

  async stop(): Promise<void> {
    this.dropAll();
    await this.server?.stop(true);
  }

  private result(start: number): string {
    return JSON.stringify({
      type: 'Results',
      is_final: true,
      start,
      duration: 1,
      channel: {
        alternatives: [{ transcript: `utterance ${this.utterances++}`, words: [{ speaker: 0 }] }],
      },
    });
  }
}
