import { AsyncQueue } from "./async-queue";
import type { SourceSegment, TranscriptSource } from "./source";

export type MergedPrimary = {
  source: TranscriptSource;
  /** Stamped on every segment of this source, or null to leave the segments as they come. */
  speakerKey: string | null;
};

type Child = {
  source: TranscriptSource;
  speakerKey: string | null;
  abort: AbortController;
};

/**
 * Several sources written through one appender, which orders and numbers the rows. The
 * primary source is the meeting itself: when it ends, so does everything else. Others (a
 * second person's microphone) come and go while it runs, and one failing or ending leaves
 * the rest untouched.
 */
export class MergedSource implements TranscriptSource {
  private readonly queue = new AsyncQueue<SourceSegment>();
  private readonly children = new Set<Child>();
  private parent: AbortSignal | null = null;
  private done = false;

  constructor(
    private readonly primary: MergedPrimary,
    /** A child's stream ended or failed; it is no longer part of the merge. */
    private readonly onChildEnd?: (source: TranscriptSource, error?: unknown) => void,
  ) {}

  /** Number of children still running. */
  get size(): number {
    return this.children.size;
  }

  /** Adds a source to a merge that is running. False when the merge has not started or is over. */
  add(source: TranscriptSource, speakerKey: string | null): boolean {
    if (!this.parent || this.done) return false;
    const child: Child = { source, speakerKey, abort: new AbortController() };
    this.children.add(child);
    const stop = () => child.abort.abort();
    this.parent.addEventListener("abort", stop, { once: true });
    void this.pump(child).finally(() => this.parent?.removeEventListener("abort", stop));
    return true;
  }

  async *stream(signal: AbortSignal): AsyncGenerator<SourceSegment> {
    if (this.parent) throw new Error("a merged source can be streamed once");
    this.parent = signal;
    const primary = this.pumpPrimary(signal);
    try {
      yield* this.queue;
    } finally {
      this.finish();
      await primary;
    }
  }

  private async pumpPrimary(signal: AbortSignal): Promise<void> {
    try {
      for await (const segment of this.primary.source.stream(signal)) {
        this.queue.push(stamp(segment, this.primary.speakerKey));
      }
      this.finish();
    } catch (error) {
      this.finish(error);
    }
  }

  private async pump(child: Child): Promise<void> {
    let failure: unknown;
    try {
      for await (const segment of child.source.stream(child.abort.signal)) {
        this.queue.push(stamp(segment, child.speakerKey));
      }
    } catch (error) {
      if (!child.abort.signal.aborted) failure = error;
    } finally {
      this.children.delete(child);
      this.onChildEnd?.(child.source, failure);
    }
  }

  /** The meeting is over: stop the children and let the consumer drain what is queued. */
  private finish(error?: unknown): void {
    this.done = true;
    for (const child of this.children) child.abort.abort();
    this.queue.close(error);
  }
}

function stamp(segment: SourceSegment, speakerKey: string | null): SourceSegment {
  return speakerKey === null ? segment : { ...segment, speakerKey };
}
