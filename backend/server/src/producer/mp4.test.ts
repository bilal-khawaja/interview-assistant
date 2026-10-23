import { describe, expect, test } from "bun:test";
import { Fmp4Tracker } from "./mp4";

function box(type: string, payload: number[] | Uint8Array): Uint8Array {
  const body = Uint8Array.from(payload);
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(body, 8);
  return out;
}

const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
};

const ftyp = box("ftyp", [1, 2, 3, 4]);
const moov = box("moov", [5, 6, 7, 8, 9]);
const sidx = box("sidx", new Array(30).fill(9));
const frag = (n: number) => [box("moof", [n, n]), box("mdat", new Array(20).fill(n))];
const stream = join(ftyp, moov, sidx, ...frag(1), box("free", [0, 0, 0]), ...frag(2), ...frag(3));
const fragBytes = (n: number) => join(...frag(n));

function feed(tracker: Fmp4Tracker, data: Uint8Array, step: number) {
  const forwarded: Uint8Array[] = [];
  const fragments = [];
  for (let at = 0; at < data.length; at += step) {
    const out = tracker.push(data.subarray(at, at + step));
    forwarded.push(out.forward);
    fragments.push(...out.fragments);
  }
  return { forwarded: join(...forwarded), fragments };
}

describe("Fmp4Tracker", () => {
  for (const step of [stream.length, 64, 7, 1]) {
    test(`forwards init and fragments, drops index boxes, splits into whole fragments (input in ${step}-byte pieces)`, () => {
      const t = new Fmp4Tracker();
      const { forwarded, fragments } = feed(t, stream, step);
      expect(t.active).toBe(true);
      expect(forwarded).toEqual(join(ftyp, moov, fragBytes(1), fragBytes(2), fragBytes(3)));
      expect(t.initBytes()).toEqual(join(ftyp, moov));
      expect(fragments.map((f) => f.data)).toEqual([fragBytes(1), fragBytes(2), fragBytes(3)]);
      expect(fragments[0]).toMatchObject({ startMedia: 0, endMedia: fragBytes(1).length });
      expect(fragments[1]!.startMedia).toBe(fragBytes(1).length);
      expect(t.mediaBytes).toBe(fragBytes(1).length * 3);
      expect(t.partial()).toBeNull();
    });
  }

  test("a fragment still arriving is available as partial, with its start", () => {
    const t = new Fmp4Tracker();
    const cut = join(ftyp, moov, sidx, fragBytes(1), box("free", [0, 0, 0])).length + 12; // 12 bytes into fragment 2
    t.push(stream.subarray(0, cut));
    const partial = t.partial()!;
    expect(partial.startMedia).toBe(fragBytes(1).length);
    expect(partial.data).toEqual(fragBytes(2).subarray(0, partial.data.length));
    expect(partial.data.length).toBeGreaterThan(0);
    expect(partial.data.length).toBeLessThanOrEqual(12);
  });

  test("a header cut in two is not forwarded until it is whole", () => {
    const t = new Fmp4Tracker();
    const first = t.push(ftyp.subarray(0, 5));
    expect(first.forward.length).toBe(0);
    expect(t.push(ftyp.subarray(5)).forward).toEqual(ftyp);
  });

  test("a stream that is not a fragmented MP4 passes through untouched", () => {
    const raw = Uint8Array.from({ length: 200 }, (_, i) => (i * 7) % 256);
    const t = new Fmp4Tracker();
    const { forwarded } = feed(t, raw, 13);
    expect(t.active).toBe(false);
    expect(forwarded).toEqual(raw);
  });

  test("a plain MP4 (mdat with no moof) is passed through, not resumed mid-file", () => {
    const plain = join(ftyp, moov, box("mdat", new Array(50).fill(3)));
    const t = new Fmp4Tracker();
    const { forwarded } = feed(t, plain, 10);
    expect(t.active).toBe(false);
    expect(forwarded).toEqual(plain);
  });
});
