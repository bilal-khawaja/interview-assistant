import type { SegmentAppender } from "../log/append";
import type { TranscriptSegment } from "../db/schema";
import { abortableSleep } from "../retry";
import type { SourceSegment, TranscriptSource } from "./source";

export type SegmentSink = Pick<SegmentAppender, "append" | "appendGap" | "pending">;

export const GAP_SOURCE = "gap";
export const DEFAULT_MAX_PENDING = 20_000;

export type RunOptions = {
  /** Rows allowed to wait for the database. Segments are small, so this is only a few MB. */
  maxPending?: number;
  /**
   * What to do at maxPending. "wait" pauses the source until the database catches up,
   * which suits files and replays. "drop" keeps a live source flowing, discards the
   * overflow and records it as one gap row once there is room.
   */
  whenFull?: "wait" | "drop";
  onAppend?: (row: TranscriptSegment, segment: SourceSegment) => void;
  onDrop?: (dropped: { count: number; startMs: number; endMs: number }) => void;
};

const POLL_MS = 50;

/**
 * Feeds a source into the appender without waiting for each write, so a slow or
 * unreachable database never stalls ingest. Rows queue in the appender, which
 * keeps retrying; a permanent write error stops the run.
 */
export async function appendFromSource(
  source: TranscriptSource,
  sink: SegmentSink,
  signal: AbortSignal,
  options: RunOptions = {},
): Promise<number> {
  const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
  const whenFull = options.whenFull ?? "wait";
  let failure: unknown = null;
  let accepted = 0;
  let last: Promise<unknown> = Promise.resolve();
  let dropped: { count: number; startMs: number; endMs: number } | null = null;

  const submit = (segment: SourceSegment) => {
    const write =
      segment.source === GAP_SOURCE
        ? sink.appendGap(segment.startMs, segment.endMs)
        : sink.append(segment);
    accepted++;
    last = write.then(
      (row) => options.onAppend?.(row, segment),
      (error) => {
        failure ??= error;
      },
    );
  };

  for await (const segment of source.stream(signal)) {
    if (failure) throw failure;

    if (sink.pending >= maxPending) {
      if (whenFull === "drop") {
        dropped = dropped
          ? { ...dropped, count: dropped.count + 1, endMs: Math.max(dropped.endMs, segment.endMs) }
          : { count: 1, startMs: segment.startMs, endMs: segment.endMs };
        continue;
      }
      while (sink.pending >= maxPending && !failure && !signal.aborted) {
        await abortableSleep(POLL_MS, signal);
      }
      if (failure) throw failure;
    }

    if (dropped) {
      options.onDrop?.(dropped);
      submit({ text: "", startMs: dropped.startMs, endMs: dropped.endMs, source: GAP_SOURCE });
      dropped = null;
    }
    submit(segment);
  }

  if (dropped) {
    options.onDrop?.(dropped);
    submit({ text: "", startMs: dropped.startMs, endMs: dropped.endMs, source: GAP_SOURCE });
  }
  // Wait for the queued rows, unless the run was aborted: close() has its own drain limit.
  await Promise.race([
    last,
    new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    }),
  ]);
  if (failure) throw failure;
  return accepted;
}
