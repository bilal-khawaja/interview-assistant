import type { TranscriptSegment } from '../types/transcript';

export const GAP_SOURCE = 'gap';

/** 72_000 -> "1:12", 3_725_000 -> "1:02:05". */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "spk_2" -> 2; null when the key carries no number. */
export function speakerIndex(key: string | null): number | null {
  const match = key ? /(\d+)$/.exec(key) : null;
  return match ? Number(match[1]) : null;
}

export function speakerName(segment: Pick<TranscriptSegment, 'speaker' | 'speakerKey'>): string {
  const known = segment.speaker?.person.fullName?.trim() || segment.speaker?.label?.trim();
  if (known) return known;
  const index = speakerIndex(segment.speakerKey);
  return index === null ? 'Speaker' : `Speaker ${index + 1}`;
}

export type TranscriptGroup =
  | { kind: 'speech'; id: number; speakerKey: string | null; name: string; startMs: number; segments: TranscriptSegment[] }
  | { kind: 'gap'; id: number; startMs: number; endMs: number };

/** Longest pause between two segments of one speaker that still reads as one turn. */
const SAME_TURN_MS = 15_000;
/** Longest a single block runs before a new one starts, so a monologue stays readable. */
const MAX_TURN_SPAN_MS = 30_000;

/**
 * Folds the flat segment list into speaking turns: consecutive segments from one speaker
 * share a header, and a connection gap becomes its own marker. A group's id is the seq of
 * its first segment, which stays put as more segments arrive.
 */
export function groupSegments(segments: readonly TranscriptSegment[]): TranscriptGroup[] {
  const groups: TranscriptGroup[] = [];
  for (const segment of segments) {
    if (segment.source === GAP_SOURCE) {
      groups.push({ kind: 'gap', id: segment.seq, startMs: segment.startMs, endMs: segment.endMs });
      continue;
    }
    if (!segment.text.trim()) continue;
    const last = groups.at(-1);
    if (
      last?.kind === 'speech' &&
      last.speakerKey === segment.speakerKey &&
      segment.startMs - last.segments[last.segments.length - 1]!.endMs <= SAME_TURN_MS &&
      segment.startMs - last.startMs <= MAX_TURN_SPAN_MS
    ) {
      last.segments.push(segment);
      continue;
    }
    groups.push({
      kind: 'speech',
      id: segment.seq,
      speakerKey: segment.speakerKey,
      name: speakerName(segment),
      startMs: segment.startMs,
      segments: [segment],
    });
  }
  return groups;
}
