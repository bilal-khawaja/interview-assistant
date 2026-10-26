import { transcribeAudio, type DeepgramOptions } from "./deepgram";
import type { SourceSegment, TranscriptSource } from "./source";

/** What a microphone client sends: headerless 16-bit little-endian PCM, 16 kHz, mono. */
export const LIVE_SAMPLE_RATE = 16_000;
export const LIVE_BYTES_PER_SECOND = LIVE_SAMPLE_RATE * 2;

const DEFAULT_MAX_BUFFERED_MS = 30_000;

export type LiveAudioOptions = {
  deepgram: DeepgramOptions;
  baseMs: number;
  /** Most audio held while Deepgram is unreachable. The oldest is dropped past it. */
  maxBufferedMs?: number;
  /** End the source after this long without audio. 0 never ends it. */
  idleTimeoutMs?: number;
  onDrop?: (droppedBytes: number) => void;
};

/**
 * A transcript source fed by a client: push() takes PCM chunks as they arrive and the
 * stream ends when end() is called, the signal aborts or the audio goes idle. PCM has no
 * header, so a reconnect to Deepgram resumes mid-stream and the bitrate is known, which
 * keeps gap timing and the resend buffer exact.
 */
export class LiveAudioSource implements TranscriptSource {
  private readonly queue: Uint8Array[] = [];
  private queuedBytes = 0;
  private carry: number | null = null;
  private ended = false;
  private wake: (() => void) | null = null;
  private lastPushAt = Date.now();

  constructor(private readonly options: LiveAudioOptions) {}

  /** Bytes dropped because Deepgram could not keep up. */
  droppedBytes = 0;

  get isEnded(): boolean {
    return this.ended;
  }

  /** Accepts a chunk of PCM. Returns false once the source has ended. */
  push(chunk: Uint8Array): boolean {
    if (this.ended) return false;
    this.lastPushAt = Date.now();
    let data = chunk;
    if (this.carry !== null) {
      // Samples are two bytes; a chunk split mid-sample is stitched to the next one.
      const joined = new Uint8Array(data.length + 1);
      joined[0] = this.carry;
      joined.set(data, 1);
      data = joined;
      this.carry = null;
    }
    if (data.length % 2 === 1) {
      this.carry = data[data.length - 1]!;
      data = data.subarray(0, data.length - 1);
    }
    if (data.length === 0) return true;

    this.queue.push(data);
    this.queuedBytes += data.length;
    const maxBytes = Math.floor(
      ((this.options.maxBufferedMs ?? DEFAULT_MAX_BUFFERED_MS) * LIVE_BYTES_PER_SECOND) / 1000,
    );
    let dropped = 0;
    while (this.queuedBytes > maxBytes && this.queue.length > 1) {
      const oldest = this.queue.shift()!;
      this.queuedBytes -= oldest.length;
      dropped += oldest.length;
    }
    if (dropped > 0) {
      this.droppedBytes += dropped;
      this.options.onDrop?.(dropped);
    }
    this.poke();
    return true;
  }

  /** No more audio is coming. What was pushed is still transcribed. */
  end(): void {
    this.ended = true;
    this.poke();
  }

  stream(signal: AbortSignal): AsyncIterable<SourceSegment> {
    return transcribeAudio(
      {
        ...this.options.deepgram,
        pcm: { sampleRate: LIVE_SAMPLE_RATE, channels: 1 },
        bytesPerSecond: LIVE_BYTES_PER_SECOND,
      },
      this.audio(signal),
      signal,
      this.options.baseMs,
    );
  }

  private poke(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private async *audio(signal: AbortSignal): AsyncGenerator<Uint8Array> {
    const idleMs = this.options.idleTimeoutMs ?? 0;
    this.lastPushAt = Date.now();
    for (;;) {
      const next = this.queue.shift();
      if (next) {
        this.queuedBytes -= next.length;
        yield next;
        continue;
      }
      if (this.ended || signal.aborted) return;
      if (idleMs > 0 && Date.now() - this.lastPushAt >= idleMs) {
        this.ended = true;
        return;
      }
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        };
        // Wake at least once a second while an idle limit is set, to notice it elapse.
        if (idleMs > 0) timer = setTimeout(done, Math.min(idleMs, 1_000));
        this.wake = done;
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }
}
