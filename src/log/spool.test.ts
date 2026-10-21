import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SegmentSpool, type SpoolRow } from "./spool";

const dirs: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "spool-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const row = (seq: number, extra: Partial<SpoolRow> = {}): SpoolRow => ({
  seq,
  speakerKey: "spk_0",
  text: `row ${seq}`,
  startMs: seq * 1000,
  endMs: seq * 1000 + 900,
  source: "deepgram",
  ...extra,
});

describe("SegmentSpool", () => {
  test("rows written by one instance are read back by another, with their speaker labels", () => {
    const dir = tmp();
    const a = new SegmentSpool(dir, "m1");
    a.append(row(1));
    a.append(row(2, { speakerKey: null, text: "", source: "gap" }));
    a.close();

    const read = new SegmentSpool(dir, "m1").read();
    expect(read.skipped).toBe(0);
    expect(read.rows.map((r) => [r.seq, r.speakerKey, r.source])).toEqual([
      [1, "spk_0", "deepgram"],
      [2, null, "gap"],
    ]);
  });

  test("a line cut short by a crash is skipped and the rest survive", () => {
    const dir = tmp();
    const spool = new SegmentSpool(dir, "m1");
    spool.append(row(1));
    spool.append(row(2));
    appendFileSync(spool.path, '{"seq":3,"text":"half writ');
    spool.close();

    const read = new SegmentSpool(dir, "m1").read();
    expect(read.rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(read.skipped).toBe(1);
  });

  test("reset empties the file and appending afterwards still works", () => {
    const dir = tmp();
    const spool = new SegmentSpool(dir, "m1");
    spool.append(row(1));
    spool.append(row(2));
    spool.reset();
    expect(statSync(spool.path).size).toBe(0);
    spool.append(row(3));
    expect(readFileSync(spool.path, "utf8").trim().split("\n")).toHaveLength(1);
    expect(spool.read().rows.map((r) => r.seq)).toEqual([3]);
    spool.close();
  });

  test("a missing file reads as empty and spools of different meetings do not mix", () => {
    const dir = tmp();
    expect(new SegmentSpool(dir, "none").read()).toEqual({ rows: [], skipped: 0 });
    const a = new SegmentSpool(dir, "a");
    const b = new SegmentSpool(dir, "b");
    a.append(row(1));
    b.append(row(9));
    expect(a.read().rows.map((r) => r.seq)).toEqual([1]);
    expect(b.read().rows.map((r) => r.seq)).toEqual([9]);
    a.close();
    b.close();
  });
});
