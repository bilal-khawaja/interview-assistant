import { backoffDelay, toWebSocketUrl } from '../backend-url';
import type { SocketFactory } from './transcript-stream.client';

export type UplinkState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface AudioUplinkOptions {
  baseUrl: string;
  meetingId: string;
  /** Most audio held while the socket is down. The oldest is dropped past it. */
  maxQueuedBytes?: number;
  onState?: (state: UplinkState, detail?: string) => void;
  createSocket?: SocketFactory;
  reconnect?: { baseMs?: number; maxMs?: number };
}

const OPEN = 1;
/** The backend closes the socket with this when the account was removed from, or left, the meeting. */
const ACCESS_REVOKED = 4403;
const DEFAULT_MAX_QUEUED_BYTES = 16_000 * 2 * 10; // ten seconds of 16 kHz PCM16
const DEFAULT_BASE_MS = 250;
const DEFAULT_MAX_MS = 3_000;
// Past this much unsent data on an open socket the network is not keeping up.
const MAX_SOCKET_BACKLOG_BYTES = 16_000 * 2 * 20;

/**
 * Forwards microphone audio to the backend's live-audio socket. While the socket is down
 * (or backed up) audio waits in a bounded queue, newest kept, and is sent in order once the
 * connection returns, so a brief drop does not cost speech. It retries until close(); the
 * owner closes it when the meeting ends, since the backend refuses audio for a meeting
 * that is over.
 */
export class AudioUplink {
  private socket: WebSocket | null = null;
  private queue: Uint8Array[] = [];
  private queuedBytes = 0;
  private closed = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private state: UplinkState | null = null;
  droppedBytes = 0;
  sentBytes = 0;

  constructor(private readonly options: AudioUplinkOptions) {}

  start(): void {
    this.closed = false;
    this.connect();
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    const socket = this.socket;
    this.socket = null;
    this.queue = [];
    this.queuedBytes = 0;
    try {
      socket?.close();
    } catch {
      // already closed
    }
    this.setState('closed');
  }

  get isOpen(): boolean {
    return this.socket?.readyState === OPEN;
  }

  push(chunk: Uint8Array): void {
    if (this.closed || chunk.length === 0) return;
    const socket = this.socket;
    if (socket && socket.readyState === OPEN && this.queue.length === 0) {
      if (socket.bufferedAmount > MAX_SOCKET_BACKLOG_BYTES) {
        this.drop(chunk.length);
        return;
      }
      socket.send(chunk as Uint8Array<ArrayBuffer>);
      this.sentBytes += chunk.length;
      return;
    }
    this.queue.push(chunk);
    this.queuedBytes += chunk.length;
    const max = this.options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
    while (this.queuedBytes > max && this.queue.length > 1) {
      const oldest = this.queue.shift()!;
      this.queuedBytes -= oldest.length;
      this.drop(oldest.length);
    }
  }

  private drop(bytes: number): void {
    this.droppedBytes += bytes;
  }

  private setState(state: UplinkState, detail?: string): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onState?.(state, detail);
  }

  private connect(): void {
    if (this.closed) return;
    if (this.attempt === 0) this.setState('connecting');
    const { baseUrl, meetingId } = this.options;
    const url = `${toWebSocketUrl(baseUrl)}/meetings/${meetingId}/audio`;
    let socket: WebSocket;
    try {
      socket = (this.options.createSocket ?? ((u) => new WebSocket(u)))(url);
    } catch (error) {
      this.retry(error instanceof Error ? error.message : String(error));
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.setState('open');
      this.flush();
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (event.code === ACCESS_REVOKED) {
        this.close();
        return;
      }
      if (!this.closed) this.retry(`audio connection closed (${event.code})`);
    };
    socket.onerror = () => {
      // A close event follows.
    };
  }

  private flush(): void {
    const socket = this.socket;
    while (socket && socket.readyState === OPEN && this.queue.length > 0) {
      const chunk = this.queue.shift()!;
      this.queuedBytes -= chunk.length;
      socket.send(chunk as Uint8Array<ArrayBuffer>);
      this.sentBytes += chunk.length;
    }
  }

  private retry(detail: string): void {
    if (this.closed) return;
    this.attempt++;
    this.setState('reconnecting', detail);
    const { baseMs = DEFAULT_BASE_MS, maxMs = DEFAULT_MAX_MS } = this.options.reconnect ?? {};
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), backoffDelay(this.attempt, baseMs, maxMs));
  }
}
