import type { SQL as BunSQL } from "bun";
import type { SegmentRepository } from "../db/repositories/segment.repository";
import { tryAdvisoryLock, type AdvisoryLock } from "../db/locks";
import { isTransientDbError } from "../db/transient";
import { backoffMs } from "../retry";
import { SegmentSpool, type SpoolRow } from "./spool";
import type { MeetingStatus, TranscriptSegment } from "../db/schema";
import {
  isConstraintViolation,
  MeetingGoneError,
  ProducerAlreadyActiveError,
  ProducerConflictError,
  ProducerFailedError,
  ProducerLockLostError,
  ProducerLockUnverifiedError,
} from "./errors";

export type SegmentDraft = {
  text: string;
  startMs: number;
  endMs: number;
  speakerKey?: string | null;
  source?: string;
};

export const PRODUCER_LOCK = "transcript-producer";

export type AppenderDeps = {
  sql: BunSQL;
  segments: SegmentRepository;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** How often to verify the lock and send a heartbeat. 0 turns the monitor off. */
  lockCheckMs?: number;
  lockProbeMs?: number;
  /** Called each time the lock is verified, to record that the producer is alive. */
  onHeartbeat?: (meetingId: string) => Promise<void>;
  /**
   * Current status of the meeting, or null if it no longer exists. Checked on every
   * monitor tick and when the database comes back. A missing meeting stops the
   * appender for good (MeetingGoneError).
   */
  readMeetingStatus?: (meetingId: string) => Promise<MeetingStatus | null>;
  /**
   * Puts the meeting back to live. Called when the lock is taken back after a loss,
   * and whenever the meeting is found ended while this producer holds the lock
   * (for example the sweep ended it during an outage). If it throws while
   * reattaching, the lock is released and reattaching is retried.
   */
  onReattach?: (meetingId: string) => Promise<void>;
  /** Told when the database becomes unreachable (degraded) and when it recovers (ok). */
  onHealth?: (health: AppenderHealth) => void;
  /** How long close() waits for queued rows before abandoning them. */
  closeDrainMs?: number;
  /**
   * Directory for the write-ahead spool. When set, every accepted row is saved to disk
   * before its database write, and rows the database lacks are replayed on open.
   */
  spoolDir?: string;
  /** fsync each spool write. On by default; turn off only in tests. */
  spoolSync?: boolean;
  /** The spool could not be written. The row still goes to the database. */
  onSpoolError?: (error: unknown) => void;
  /** Check that the lock is still held right before every database write. On by default. */
  probeBeforeWrite?: boolean;
};

export type AppenderHealth = {
  state: "ok" | "degraded";
  pending: number;
  error?: unknown;
};

const DEFAULT_LOCK_CHECK_MS = 5_000;
const REACQUIRE_ATTEMPTS = 3;
const REACQUIRE_PAUSE_MS = 300;
const DEFAULT_CLOSE_DRAIN_MS = 10_000;
const OUTAGE_BACKOFF_CAP_MS = 5_000;

// Rides out a ~40s database outage (250, 500, 1000, 2000, 4000, then 5000ms waits).
export const LIVE_RETRY = {
  maxAttempts: 12,
  retryBaseMs: 250,
  retryMaxMs: 5_000,
} as const;

export class SegmentAppender {
  private nextSeq: number;
  private tail: Promise<unknown> = Promise.resolve();
  private failure: Error | null = null;
  private closed = false;
  private lockLost = false;
  private checking = false;
  private abandon = false;
  private waiting = 0;
  private degraded = false;
  private unwritten = false;
  private replayCount = 0;
  private tailOfReplay: { endMs: number; at: number } | null = null;
  private monitor: ReturnType<typeof setInterval> | undefined;

  private constructor(
    private readonly deps: AppenderDeps,
    readonly meetingId: string,
    private lock: AdvisoryLock,
    head: number,
    private readonly spool: SegmentSpool | null,
  ) {
    this.nextSeq = head + 1;
  }

  static async open(
    deps: AppenderDeps,
    meetingId: string,
  ): Promise<SegmentAppender> {
    const lock = await tryAdvisoryLock(deps.sql, PRODUCER_LOCK, meetingId);
    if (!lock) throw new ProducerAlreadyActiveError(meetingId);
    try {
      const head = await deps.segments.head(meetingId);
      const spool = deps.spoolDir
        ? new SegmentSpool(deps.spoolDir, meetingId, deps.spoolSync ?? true)
        : null;
      const replay = (spool?.read().rows ?? [])
        .filter((row) => row.seq > head)
        .sort((a, b) => a.seq - b.seq);
      const top = replay.at(-1)?.seq ?? head;
      const appender = new SegmentAppender(deps, meetingId, lock, top, spool);
      for (const row of replay) {
        appender.queueWrite({ ...row, meetingId }).catch(() => undefined);
      }
      appender.replayCount = replay.length;
      const lastReplayed = replay.at(-1);
      if (lastReplayed && spool) {
        appender.tailOfReplay = { endMs: lastReplayed.endMs, at: spool.modifiedAt() };
      }
      if (replay.length === 0) appender.checkpoint();
      appender.startMonitor();
      return appender;
    } catch (error) {
      await lock.release();
      throw error;
    }
  }

  /** Rows found in the spool at open that the database did not have yet. */
  get replayed(): number {
    return this.replayCount;
  }

  /** End time and wall-clock time of the newest row recovered from the spool, if any. */
  get replayTail(): { endMs: number; at: number } | null {
    return this.tailOfReplay;
  }

  /** Rows accepted but not yet written. They wait in memory while the database is down. */
  get pending(): number {
    return this.waiting;
  }

  get health(): AppenderHealth {
    return { state: this.degraded ? "degraded" : "ok", pending: this.waiting };
  }

  /** Backend pid of the session holding the producer lock. */
  get lockPid(): number {
    return this.lock.pid;
  }

  get lastAssignedSeq(): number {
    return this.nextSeq - 1;
  }

  append(draft: SegmentDraft): Promise<TranscriptSegment> {
    return this.enqueue(base(draft));
  }

  appendGap(startMs: number, endMs: number): Promise<TranscriptSegment> {
    return this.enqueue(base({ text: "", startMs, endMs, source: "gap" }));
  }

  async flush(): Promise<void> {
    await this.tail.catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.monitor);
    const drained = await Promise.race([
      this.flush().then(() => true),
      Bun.sleep(this.deps.closeDrainMs ?? DEFAULT_CLOSE_DRAIN_MS).then(() => false),
    ]);
    if (!drained) {
      this.abandon = true;
      await this.flush();
    }
    await this.lock.release().catch(() => undefined);
    this.spool?.close();
  }

  private startMonitor(): void {
    const everyMs = this.deps.lockCheckMs ?? DEFAULT_LOCK_CHECK_MS;
    if (everyMs <= 0) return;
    void this.beat();
    this.monitor = setInterval(() => void this.checkLock(), everyMs);
  }

  private async beat(): Promise<void> {
    try {
      await this.deps.onHeartbeat?.(this.meetingId);
    } catch {
      return;
    }
  }

  /**
   * Heartbeat, plus a look at the meeting row: gone means stop, ended means this producer
   * still holds the lock so the meeting goes back to live.
   */
  private async confirmAlive(): Promise<void> {
    try {
      const status = await this.deps.readMeetingStatus?.(this.meetingId);
      if (status === null) {
        this.failure ??= new MeetingGoneError(this.meetingId);
        return;
      }
      if (status === "ended") await this.deps.onReattach?.(this.meetingId);
    } catch {
      // the database is flaky; the next tick tries again
    }
    await this.beat();
  }

  private async checkLock(): Promise<void> {
    if (this.checking || this.closed || this.failure) return;
    this.checking = true;
    try {
      if (await this.lock.isHeld(this.deps.lockProbeMs)) {
        this.lockLost = false;
        await this.confirmAlive();
        return;
      }
      this.lockLost = true;
      await this.reacquire();
    } finally {
      this.checking = false;
    }
  }

  /** Start taking the lock back unless an attempt is already running. */
  private recover(): void {
    if (this.checking || this.closed || this.failure) return;
    this.checking = true;
    void this.reacquire().finally(() => {
      this.checking = false;
    });
  }

  private async reacquire(): Promise<void> {
    await this.lock.release().catch(() => undefined);
    for (let attempt = 1; attempt <= REACQUIRE_ATTEMPTS; attempt++) {
      let lock: AdvisoryLock | null;
      try {
        lock = await tryAdvisoryLock(this.deps.sql, PRODUCER_LOCK, this.meetingId);
      } catch {
        return; // database unreachable: stay unverified and try again next tick
      }
      if (lock) {
        try {
          const head = await this.deps.segments.head(this.meetingId);
          if (head > this.nextSeq - 1) {
            await lock.release().catch(() => undefined);
            this.failure = new ProducerLockLostError(this.meetingId);
            return;
          }
        } catch {
          await lock.release().catch(() => undefined);
          return;
        }
        try {
          const status = await this.deps.readMeetingStatus?.(this.meetingId);
          if (status === null) {
            await lock.release().catch(() => undefined);
            this.failure ??= new MeetingGoneError(this.meetingId);
            return;
          }
          await this.deps.onReattach?.(this.meetingId);
        } catch {
          await lock.release().catch(() => undefined);
          return;
        }
        this.lock = lock;
        this.lockLost = false;
        await this.beat();
        return;
      }
      if (attempt < REACQUIRE_ATTEMPTS) await Bun.sleep(REACQUIRE_PAUSE_MS);
    }
    this.failure = new ProducerLockLostError(this.meetingId);
  }

  private enqueue(
    row: Omit<Row, "meetingId" | "seq">,
  ): Promise<TranscriptSegment> {
    if (this.closed) return Promise.reject(new Error("appender closed"));
    if (this.failure) return Promise.reject(this.failure);

    const seq = this.nextSeq++;
    const full: Row = { ...row, meetingId: this.meetingId, seq };
    this.save(full);
    return this.queueWrite(full);
  }

  private save(row: Row): void {
    if (!this.spool) return;
    try {
      this.spool.append(row);
    } catch (error) {
      this.deps.onSpoolError?.(error);
    }
  }

  private queueWrite(row: Row): Promise<TranscriptSegment> {
    this.waiting++;
    const result = this.tail.then(() => {
      if (this.failure) throw this.failure;
      return this.write(row);
    });
    this.tail = result.then(
      () => {
        this.waiting--;
        this.checkpoint();
      },
      () => {
        this.waiting--;
        this.unwritten = true;
      },
    );
    return result;
  }

  /** Once the database holds everything accepted so far, the spool has nothing left to protect. */
  private checkpoint(): void {
    if (this.waiting !== 0 || this.unwritten || !this.spool) return;
    try {
      this.spool.reset();
    } catch (error) {
      this.deps.onSpoolError?.(error);
    }
  }

  private setDegraded(degraded: boolean, error?: unknown): void {
    if (this.degraded === degraded) return;
    this.degraded = degraded;
    // Back from an outage: say so right away instead of waiting for the next tick, so the
    // sweep does not end a meeting whose heartbeat went stale while the database was down.
    if (!degraded) void this.confirmAlive();
    this.deps.onHealth?.({ state: degraded ? "degraded" : "ok", pending: this.waiting, error });
  }

  private async write(row: Row): Promise<TranscriptSegment> {
    const maxAttempts = this.deps.maxAttempts ?? 5;
    const baseMs = this.deps.retryBaseMs ?? 100;
    const maxMs = this.deps.retryMaxMs ?? Infinity;
    let lastError: unknown;
    let attempt = 0; // failures that say something is wrong with the row or the code
    let outage = 0; // consecutive "database unreachable" failures; these never run out

    for (;;) {
      try {
        if (this.failure) throw this.failure;
        if (this.abandon) throw new Error("appender closed before this row could be written");
        if (!this.lockLost && this.deps.probeBeforeWrite !== false) {
          if (!(await this.lock.isHeld(this.deps.lockProbeMs))) this.lockLost = true;
        }
        if (this.lockLost) {
          this.recover();
          throw new ProducerLockUnverifiedError(this.meetingId);
        }
        const [inserted] = await this.deps.segments.appendIgnore([row]);
        let written = inserted;
        if (!written) {
          const existing = await this.deps.segments.findBySeq(row.meetingId, row.seq);
          if (!existing || !sameSegment(existing, row)) {
            throw new ProducerConflictError(row.meetingId, row.seq);
          }
          written = existing;
        }
        this.setDegraded(false);
        return written;
      } catch (error) {
        lastError = error;
        if (
          this.abandon ||
          error instanceof ProducerConflictError ||
          error instanceof ProducerLockLostError ||
          (this.failure !== null && error === this.failure) ||
          isConstraintViolation(error)
        ) {
          break;
        }
        if (isTransientDbError(error) || error instanceof ProducerLockUnverifiedError) {
          this.setDegraded(true, error);
          await Bun.sleep(backoffMs(++outage, baseMs, Math.min(maxMs, OUTAGE_BACKOFF_CAP_MS)));
          continue;
        }
        outage = 0;
        if (++attempt >= maxAttempts) break;
        await Bun.sleep(backoffMs(attempt, baseMs, maxMs));
      }
    }

    this.failure ??= new ProducerFailedError(lastError);
    throw lastError;
  }
}

type Row = {
  meetingId: string;
  seq: number;
  speakerKey: string | null;
  text: string;
  startMs: number;
  endMs: number;
  source: string;
};

function base(draft: SegmentDraft) {
  return {
    speakerKey: draft.speakerKey ?? null,
    text: draft.text,
    startMs: draft.startMs,
    endMs: draft.endMs,
    source: draft.source ?? "stt",
  };
}

function sameSegment(existing: TranscriptSegment, row: Row): boolean {
  return (
    existing.text === row.text &&
    existing.startMs === row.startMs &&
    existing.endMs === row.endMs &&
    existing.speakerKey === row.speakerKey &&
    existing.source === row.source
  );
}
