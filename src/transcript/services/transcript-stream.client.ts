import type { StreamStatus, TranscriptSegment } from '../../types/transcript';
import { backoffDelay, toWebSocketUrl } from '../backend-url';

export type SocketFactory = (url: string) => WebSocket;

export interface StreamClientOptions {
  baseUrl: string;
  meetingId: string;
  /** Resume point: only segments after this sequence number are delivered. */
  after?: number;
  onSegment: (segment: TranscriptSegment) => void;
  onStatus: (status: StreamStatus, detail?: string) => void;
  /** The server's log is behind our cursor, so we restarted from zero. */
  onReset?: () => void;
  createSocket?: SocketFactory;
  reconnect?: { baseMs?: number; maxMs?: number };
  /** The connection is declared dead after this many heartbeat intervals of silence. */
  silenceFactor?: number;
}

const CURSOR_AHEAD = 4409;
const DEFAULT_BASE_MS = 500;
const DEFAULT_MAX_MS = 10_000;
const DEFAULT_SILENCE_FACTOR = 2.5;

type ServerFrame =
  | { type: 'ready'; head: number; heartbeatMs: number }
  | ({ type: 'segment' } & TranscriptSegment)
  | { type: 'heartbeat' }
  | { type: 'degraded'; reason: string }
  | { type: 'recovered' }
  | { type: 'error'; code: string; message: string };

/**
 * One meeting's transcript stream. Reconnects forever with backoff and always resumes after
 * the last sequence number it delivered, so a dropped connection never loses or repeats a
 * segment. A watchdog treats silence longer than a few heartbeats as a dead connection,
 * which the WebSocket itself can take minutes to notice.
 */
export class TranscriptStreamClient {
  private socket: WebSocket | null = null;
  private stopped = true;
  private attempt = 0;
  private everLive = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private heartbeatMs = 0;
  private status: StreamStatus | null = null;
  private detail: string | undefined;
  private lastActivityAt = 0;
  lastSeq: number;

  constructor(private readonly options: StreamClientOptions) {
    this.lastSeq = options.after ?? 0;
  }

  /**
   * Milliseconds since the stream last delivered a segment or (re)connected, 0 while it is
   * not connected. A caught-up stream of a finished meeting stays quiet at this value.
   */
  quietMs(now = Date.now()): number {
    return this.status === 'live' || this.status === 'degraded' ? now - this.lastActivityAt : 0;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.watchdog);
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close();
    } catch {
      // already closed
    }
  }

  private url(): string {
    const { baseUrl, meetingId } = this.options;
    return `${toWebSocketUrl(baseUrl)}/meetings/${meetingId}/stream?after=${this.lastSeq}`;
  }

  private setStatus(status: StreamStatus, detail?: string): void {
    if (this.status === status && this.detail === detail) return;
    this.status = status;
    this.detail = detail;
    this.options.onStatus(status, detail);
  }

  private connect(): void {
    if (this.stopped) return;
    if (this.attempt === 0 && !this.everLive) this.setStatus('connecting');
    let socket: WebSocket;
    try {
      socket = (this.options.createSocket ?? ((url) => new WebSocket(url)))(this.url());
    } catch (error) {
      this.scheduleReconnect(error instanceof Error ? error.message : String(error));
      return;
    }
    this.socket = socket;
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.handle(String(event.data));
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      clearTimeout(this.watchdog);
      if (this.stopped) return;
      this.scheduleReconnect(
        event.code === CURSOR_AHEAD ? 'resyncing from the start' : `connection closed (${event.code})`,
      );
    };
    socket.onerror = () => {
      // A close event always follows; reconnecting happens there.
    };
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    this.attempt++;
    this.setStatus('reconnecting', reason);
    const { baseMs = DEFAULT_BASE_MS, maxMs = DEFAULT_MAX_MS } = this.options.reconnect ?? {};
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), backoffDelay(this.attempt, baseMs, maxMs));
  }

  private armWatchdog(): void {
    clearTimeout(this.watchdog);
    if (this.heartbeatMs <= 0) return;
    const limit = this.heartbeatMs * (this.options.silenceFactor ?? DEFAULT_SILENCE_FACTOR);
    this.watchdog = setTimeout(() => {
      const dead = this.socket;
      this.socket = null;
      try {
        dead?.close();
      } catch {
        // already closed
      }
      this.scheduleReconnect('no data from the server');
    }, limit);
  }

  private handle(raw: string): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(raw) as ServerFrame;
    } catch {
      return;
    }
    switch (frame.type) {
      case 'ready':
        this.attempt = 0;
        this.everLive = true;
        this.heartbeatMs = frame.heartbeatMs;
        this.lastActivityAt = Date.now();
        this.setStatus('live');
        this.armWatchdog();
        break;
      case 'heartbeat':
        this.armWatchdog();
        break;
      case 'segment': {
        this.armWatchdog();
        if (frame.seq <= this.lastSeq) return;
        this.lastSeq = frame.seq;
        this.lastActivityAt = Date.now();
        const { type: _type, ...segment } = frame;
        this.options.onSegment(segment);
        break;
      }
      case 'degraded':
        this.armWatchdog();
        this.setStatus('degraded', frame.reason);
        break;
      case 'recovered':
        this.armWatchdog();
        this.setStatus('live');
        break;
      case 'error':
        if (frame.code === 'cursor_ahead') {
          this.lastSeq = 0;
          this.lastActivityAt = 0;
          this.options.onReset?.();
        }
        break;
    }
  }
}
