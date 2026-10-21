import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplaySource, loadFixture } from "./replay";
import type { SourceSegment } from "./source";

const FIXTURE = "fixtures/7ARBJQn6QkM.json";
const scratch = await mkdtemp(join(tmpdir(), "replay-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

async function collect(source: ReplaySource): Promise<SourceSegment[]> {
  const out: SourceSegment[] = [];
  for await (const segment of source.stream(new AbortController().signal)) out.push(segment);
  return out;
}

describe("recorded fixture", () => {
  test("is a real transcript: ordered, non-empty, multiple diarized speakers", async () => {
    const fixture = await loadFixture(FIXTURE);
    expect(fixture.length).toBeGreaterThan(50);
    for (const [i, segment] of fixture.entries()) {
      expect(segment.text.trim().length).toBeGreaterThan(0);
      expect(segment.endMs).toBeGreaterThanOrEqual(segment.startMs);
      if (i > 0) expect(segment.startMs).toBeGreaterThanOrEqual(fixture[i - 1]!.startMs);
    }
    const speakers = new Set(fixture.map((s) => s.speakerKey).filter(Boolean));
    expect(speakers.size).toBeGreaterThanOrEqual(2);
  });
});

describe("ReplaySource", () => {
  test("emits the first N segments in order with the start offset applied", async () => {
    const fixture = await loadFixture(FIXTURE);
    const got = await collect(new ReplaySource({ file: FIXTURE, count: 3, intervalMs: 0, startOffsetMs: 10_000 }));

    expect(got.map((s) => s.text)).toEqual(fixture.slice(0, 3).map((s) => s.text));
    expect(got[0]!.startMs).toBe(fixture[0]!.startMs + 10_000);
    expect(got[2]!.endMs).toBe(fixture[2]!.endMs + 10_000);
    expect(got.every((s) => s.source === "replay")).toBe(true);
  });

  test("emits everything when no count is given", async () => {
    const fixture = await loadFixture(FIXTURE);
    const got = await collect(new ReplaySource({ file: FIXTURE, intervalMs: 0 }));
    expect(got.length).toBe(fixture.length);
  });

  test("stops when aborted", async () => {
    const abort = new AbortController();
    const seen: SourceSegment[] = [];
    for await (const segment of new ReplaySource({ file: FIXTURE, intervalMs: 0 }).stream(abort.signal)) {
      seen.push(segment);
      abort.abort();
    }
    expect(seen.length).toBe(1);
  });

  test("rejects a missing file and a malformed fixture", async () => {
    await expect(loadFixture(join(scratch, "nope.json"))).rejects.toThrow("fixture not found");

    const bad = join(scratch, "bad.json");
    await Bun.write(bad, JSON.stringify([{ text: "", startMs: 0, endMs: 1 }]));
    await expect(loadFixture(bad)).rejects.toThrow();

    const empty = join(scratch, "empty.json");
    await Bun.write(empty, "[]");
    await expect(loadFixture(empty)).rejects.toThrow();
  });
});
