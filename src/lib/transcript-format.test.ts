import { describe, expect, test } from 'bun:test';
import type { TranscriptSegment } from '../types/transcript';
import { formatClock, groupSegments, speakerIndex, speakerName } from './transcript-format';

const seg = (seq: number, over: Partial<TranscriptSegment> = {}): TranscriptSegment => ({
  seq,
  text: `t${seq}`,
  startMs: seq * 1000,
  endMs: seq * 1000 + 900,
  source: 'deepgram',
  speakerKey: 'spk_0',
  speaker: null,
  createdAt: '',
  ...over,
});

describe('formatClock', () => {
  test('formats minutes and hours', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(72_000)).toBe('1:12');
    expect(formatClock(3_725_000)).toBe('1:02:05');
    expect(formatClock(-5)).toBe('0:00');
  });
});

describe('speaker naming', () => {
  test('numbers anonymous speakers from one', () => {
    expect(speakerIndex('spk_0')).toBe(0);
    expect(speakerIndex(null)).toBeNull();
    expect(speakerName({ speaker: null, speakerKey: 'spk_1' })).toBe('Speaker 2');
    expect(speakerName({ speaker: null, speakerKey: null })).toBe('Speaker');
  });

  test('prefers a real name, then the label', () => {
    const speaker = {
      key: 'spk_0',
      participantId: 'p',
      role: 'guest',
      label: 'Interviewer',
      person: { id: 'x', fullName: 'Ada Lovelace', organization: null, jobTitle: null },
    };
    expect(speakerName({ speaker, speakerKey: 'spk_0' })).toBe('Ada Lovelace');
    expect(speakerName({ speaker: { ...speaker, person: { ...speaker.person, fullName: ' ' } }, speakerKey: 'spk_0' })).toBe('Interviewer');
  });
});

describe('groupSegments', () => {
  test('merges consecutive segments of one speaker into a turn', () => {
    const groups = groupSegments([seg(1), seg(2), seg(3, { speakerKey: 'spk_1' }), seg(4)]);
    expect(groups.map((g) => (g.kind === 'speech' ? [g.speakerKey, g.segments.length] : 'gap'))).toEqual([
      ['spk_0', 2],
      ['spk_1', 1],
      ['spk_0', 1],
    ]);
  });

  test('a long pause starts a new turn for the same speaker', () => {
    const groups = groupSegments([seg(1), seg(60)]);
    expect(groups).toHaveLength(2);
  });

  test('a long monologue is split into blocks instead of one wall of text', () => {
    const monologue = Array.from({ length: 20 }, (_, i) => seg(i + 1)); // 20 s of continuous speech
    const spread = Array.from({ length: 20 }, (_, i) => seg(i + 1, { startMs: i * 4000, endMs: i * 4000 + 3500 }));
    expect(groupSegments(monologue)).toHaveLength(1);
    expect(groupSegments(spread).length).toBeGreaterThan(1);
    const total = groupSegments(spread).reduce((n, g) => n + (g.kind === 'speech' ? g.segments.length : 0), 0);
    expect(total).toBe(20);
  });

  test('a gap segment becomes a marker and splits the turn', () => {
    const groups = groupSegments([seg(1), seg(2, { source: 'gap', text: '', speakerKey: null }), seg(3)]);
    expect(groups.map((g) => g.kind)).toEqual(['speech', 'gap', 'speech']);
  });

  test('empty text is dropped and group ids stay stable as segments arrive', () => {
    const before = groupSegments([seg(1), seg(2, { text: '  ' })]);
    const after = groupSegments([seg(1), seg(2, { text: '  ' }), seg(3)]);
    expect(before.map((g) => g.id)).toEqual([1]);
    expect(after.map((g) => g.id)).toEqual([1]);
  });
});
