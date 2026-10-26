import { describe, expect, test } from 'bun:test';
import { PCM_CHUNK_SAMPLES, PcmEncoder, rms } from './pcm';

const samples = (chunks: Uint8Array[]): number[] =>
  chunks.flatMap((c) => [...new Int16Array(c.buffer, c.byteOffset, c.byteLength / 2)]);

function sine(rate: number, hz: number, seconds: number, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / rate) * amp;
  return out;
}

function feed(encoder: PcmEncoder, signal: Float32Array, blockSize: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < signal.length; i += blockSize) {
    chunks.push(...encoder.push(signal.subarray(i, Math.min(signal.length, i + blockSize))));
  }
  return chunks;
}

describe('PcmEncoder', () => {
  test('16 kHz input passes through unchanged as 100 ms chunks of 3200 bytes', () => {
    // The newest sample waits for its successor to interpolate with, so feed a little extra.
    const input = sine(16_000, 440, 1.01);
    const chunks = feed(new PcmEncoder(16_000), input, 2048);
    expect(chunks).toHaveLength(10);
    expect(chunks.every((c) => c.length === PCM_CHUNK_SAMPLES * 2)).toBe(true);
    const out = samples(chunks);
    for (let i = 0; i < out.length; i++) {
      expect(Math.abs(out[i]! - Math.round(input[i]! * 32767))).toBeLessThanOrEqual(1);
    }
  });

  test('48 kHz input is resampled to the right duration', () => {
    const chunks = feed(new PcmEncoder(48_000), sine(48_000, 440, 2), 2048);
    // 2 s at 16 kHz is 32000 samples; whole chunks only.
    expect(chunks.length * PCM_CHUNK_SAMPLES).toBeGreaterThanOrEqual(31_000);
    expect(chunks.length * PCM_CHUNK_SAMPLES).toBeLessThanOrEqual(32_000);
  });

  test('44.1 kHz input keeps its pitch after resampling', () => {
    const out = samples(feed(new PcmEncoder(44_100), sine(44_100, 500, 1), 1024));
    let crossings = 0;
    for (let i = 1; i < out.length; i++) if (out[i - 1]! < 0 && out[i]! >= 0) crossings++;
    // 500 Hz over the ~0.9 s that came out in whole chunks.
    const seconds = out.length / 16_000;
    expect(crossings / seconds).toBeGreaterThan(480);
    expect(crossings / seconds).toBeLessThan(520);
  });

  test('block size does not change the result', () => {
    const input = sine(48_000, 300, 1);
    const a = samples(feed(new PcmEncoder(48_000), input, 128));
    const b = samples(feed(new PcmEncoder(48_000), input, 4096));
    const n = Math.min(a.length, b.length);
    expect(n).toBeGreaterThan(10_000);
    for (let i = 0; i < n; i++) expect(Math.abs(a[i]! - b[i]!)).toBeLessThanOrEqual(1);
  });

  test('loud input is clamped, not wrapped', () => {
    const loud = new Float32Array(PCM_CHUNK_SAMPLES + 4).fill(3);
    const quiet = new Float32Array(PCM_CHUNK_SAMPLES + 4).fill(-3);
    expect(Math.max(...samples(new PcmEncoder(16_000).push(loud)))).toBe(32767);
    expect(Math.min(...samples(new PcmEncoder(16_000).push(quiet)))).toBe(-32768);
  });

  test('silence stays exactly zero', () => {
    const out = samples(new PcmEncoder(48_000).push(new Float32Array(48_000)));
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  test('empty blocks are harmless and a bad rate is rejected', () => {
    const encoder = new PcmEncoder(16_000);
    expect(encoder.push(new Float32Array(0))).toEqual([]);
    expect(() => new PcmEncoder(0)).toThrow();
  });
});

describe('rms', () => {
  test('is zero for silence and about amp/sqrt(2) for a sine', () => {
    expect(rms(new Float32Array(100))).toBe(0);
    expect(rms(new Float32Array(0))).toBe(0);
    expect(rms(sine(16_000, 440, 1, 0.8))).toBeCloseTo(0.8 / Math.SQRT2, 2);
  });
});
