export const MIN_RESUME_GAP_MS = 2_000;
// start_ms and end_ms are 32-bit; six hours keeps a long break far from overflow.
export const MAX_RESUME_GAP_MS = 6 * 60 * 60 * 1000;
const RESUME_PAD_MS = 100;

export type LastSegment = {
  endMs: number;
  /** Wall-clock time (epoch ms) when this segment was recorded. */
  at: number;
};

export type ResumePlan = {
  baseMs: number;
  gap: { startMs: number; endMs: number } | null;
};

/**
 * Where a restarted producer picks up. With withGap set, wall-clock time that passed since
 * the last recorded segment is written as a gap row, so the break does not look like
 * continuous speech. Leave it off for replays, which are not real time.
 */
export function planResume(
  last: LastSegment | null,
  now: number,
  options: { withGap: boolean },
): ResumePlan {
  if (!last) return { baseMs: 0, gap: null };
  const elapsed = now - last.at;
  if (!options.withGap || elapsed < MIN_RESUME_GAP_MS) {
    return { baseMs: last.endMs + RESUME_PAD_MS, gap: null };
  }
  const gapMs = Math.min(elapsed, MAX_RESUME_GAP_MS);
  const gap = { startMs: last.endMs, endMs: last.endMs + gapMs };
  return { baseMs: gap.endMs + RESUME_PAD_MS, gap };
}
