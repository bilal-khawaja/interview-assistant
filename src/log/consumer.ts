import type { SQL as BunSQL } from "bun";
import { tryAdvisoryLock } from "../db/locks";
import { isTransientDbError } from "../db/transient";
import { abortableSleep, backoffMs } from "../retry";
import type { TranscriptSegment } from "../db/schema";
import { consume, type ConsumeDeps } from "./consume";
import type { CursorService } from "./cursor";

export type Delivery = {
  meetingId: string;
  chatId: string;
  segments: TranscriptSegment[];
  attempt: number;
};

export type DeliveryHandler = (delivery: Delivery) => Promise<void>;

export type ConsumerOptions = {
  meetingId: string;
  chatId: string;
  handler: DeliveryHandler;
  signal: AbortSignal;
  onError?: (error: unknown, delivery: Delivery) => void;
  /** The database is unreachable; the consumer is waiting to reconnect and resume from its cursor. */
  onOutage?: (error: unknown, attempt: number) => void;
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxAttempts?: number;
  exclusive?: boolean;
};

export class ConsumerAlreadyActiveError extends Error {
  constructor(readonly chatId: string) {
    super(`a consumer is already running for chat ${chatId}`);
    this.name = "ConsumerAlreadyActiveError";
  }
}

export class TranscriptConsumer {
  constructor(
    private readonly deps: ConsumeDeps & {
      sql: BunSQL;
      cursors: CursorService;
    },
  ) {}

  async run(options: ConsumerOptions): Promise<void> {
    const { signal } = options;
    const baseMs = options.retryBaseMs ?? 200;
    const maxMs = options.retryMaxMs ?? 10_000;
    let started = false;

    // A database outage drops the session, and with it the advisory lock. Wait, take
    // the lock again and resume from the committed cursor; redelivered rows are safe
    // because delivery is at-least-once.
    for (let outage = 1; !signal.aborted; outage++) {
      try {
        await this.runOnce(options, () => {
          started = true;
          outage = 0;
        });
        return;
      } catch (error) {
        const lockStillHeld = started && error instanceof ConsumerAlreadyActiveError;
        if (!isTransientDbError(error) && !lockStillHeld) throw error;
        options.onOutage?.(error, outage);
        await abortableSleep(backoffMs(outage, baseMs, maxMs), signal);
      }
    }
  }

  private async runOnce(options: ConsumerOptions, onConnected: () => void): Promise<void> {
    const { meetingId, chatId, signal } = options;

    const lock =
      options.exclusive === false
        ? null
        : await tryAdvisoryLock(this.deps.sql, "transcript-consumer", chatId);
    if (options.exclusive !== false && !lock) {
      throw new ConsumerAlreadyActiveError(chatId);
    }

    try {
      const committed = await this.deps.cursors.position(meetingId, chatId);
      onConnected();
      for await (const segments of consume(
        this.deps,
        meetingId,
        committed,
        signal,
      )) {
        await this.deliver(options, segments);
        if (signal.aborted) return;
      }
    } finally {
      // The session may already be dead; releasing must not mask the original error.
      await lock?.release().catch(() => undefined);
    }
  }

  private async deliver(
    options: ConsumerOptions,
    segments: TranscriptSegment[],
  ): Promise<void> {
    const { meetingId, chatId, signal } = options;
    const last = segments.at(-1);
    if (!last) return;
    const baseMs = options.retryBaseMs ?? 200;
    const maxMs = options.retryMaxMs ?? 10_000;

    for (let attempt = 1; ; attempt++) {
      const delivery: Delivery = { meetingId, chatId, segments, attempt };
      try {
        await options.handler(delivery);
        await this.deps.cursors.commit(meetingId, chatId, last.seq);
        return;
      } catch (error) {
        options.onError?.(error, delivery);
        if (signal.aborted) return;
        if (options.maxAttempts && attempt >= options.maxAttempts) throw error;
        await abortableSleep(backoffMs(attempt, baseMs, maxMs), signal);
      }
    }
  }
}
