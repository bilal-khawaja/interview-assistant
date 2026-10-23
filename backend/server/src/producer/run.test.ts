import { describe, expect, test } from "bun:test";
import type { TranscriptSegment } from "../db/schema";
import { appendFromSource, type SegmentSink } from "./run";
import type { SourceSegment, TranscriptSource } from "./source";

const source = (segments: SourceSegment[]): TranscriptSource => ({
  async *stream() {
    yield* segments;
  },
});

const seg = (text: string, startMs: number, endMs: number): SourceSegment => ({ text, startMs, endMs });

/** A sink whose writes complete only when the test says so. */
function gatedSink() {
  const calls: string[] = [];
  const gates: (() => void)[] = [];
  let pending = 0;
  const write = (label: string) => {
    calls.push(label);
    pending++;
    return new Promise<TranscriptSegment>((resolve) =>
      gates.push(() => {
        pending--;
        resolve({} as TranscriptSegment);
      }),
    );
  };
  const sink: SegmentSink = {
    append: (s) => write(`append:${s.text}`),
    appendGap: (a, b) => write(`gap:${a}-${b}`),
    get pending() {
      return pending;
    },
  };
  return { sink, calls, release: () => gates.splice(0).forEach((g) => g()) };
}

describe("appendFromSource", () => {
  test("routes gap segments to appendGap and everything else to append", async () => {
    const calls: string[] = [];
    const sink: SegmentSink = {
      append: async (s) => (calls.push(`append:${s.text}`), {} as TranscriptSegment),
      appendGap: async (a, b) => (calls.push(`gap:${a}-${b}`), {} as TranscriptSegment),
      pending: 0,
    };

    const count = await appendFromSource(
      source([
        seg("hi", 0, 10),
        { text: "", startMs: 10, endMs: 500, source: "gap" },
        seg("back", 500, 600),
      ]),
      sink,
      new AbortController().signal,
    );

    expect(count).toBe(3);
    expect(calls).toEqual(["append:hi", "gap:10-500", "append:back"]);
  });

  test("never waits for a write, so an unreachable database does not stall ingest", async () => {
    const { sink, calls, release } = gatedSink();
    const abort = new AbortController();
    let done = false;
    const run = appendFromSource(
      source([seg("a", 0, 1), seg("b", 1, 2), seg("c", 2, 3)]),
      sink,
      abort.signal,
    ).then(() => (done = true));

    await Bun.sleep(30);
    expect(calls).toEqual(["append:a", "append:b", "append:c"]); // all accepted, none written yet
    expect(done).toBe(false); // still waiting for the writes to land

    release();
    await run;
    expect(done).toBe(true);
  });

  test("a permanent write error stops the run", async () => {
    const sink: SegmentSink = {
      append: async () => {
        throw new Error("bad row");
      },
      appendGap: async () => ({}) as TranscriptSegment,
      pending: 0,
    };
    await expect(
      appendFromSource(source([seg("x", 0, 1)]), sink, new AbortController().signal),
    ).rejects.toThrow("bad row");
  });

  test("whenFull drop: overflow is discarded and recorded as one gap row", async () => {
    const { sink, calls, release } = gatedSink();
    const dropped: unknown[] = [];
    const run = appendFromSource(
      source([seg("a", 0, 1), seg("b", 1, 2), seg("c", 2, 3), seg("d", 3, 4)]),
      sink,
      new AbortController().signal,
      { maxPending: 2, whenFull: "drop", onDrop: (d) => dropped.push(d) },
    );
    await Bun.sleep(30);
    // c and d did not fit; the end-of-source gap row covers both
    expect(calls).toEqual(["append:a", "append:b", "gap:2-4"]);
    expect(dropped).toEqual([{ count: 2, startMs: 2, endMs: 4 }]);
    release();
    release();
    await run;
  });

  test("whenFull wait: the source pauses until the database catches up, nothing is dropped", async () => {
    const { sink, calls, release } = gatedSink();
    const run = appendFromSource(
      source([seg("a", 0, 1), seg("b", 1, 2), seg("c", 2, 3)]),
      sink,
      new AbortController().signal,
      { maxPending: 1, whenFull: "wait" },
    );
    await Bun.sleep(80);
    expect(calls).toEqual(["append:a"]); // b and c are held back
    release();
    await Bun.sleep(80);
    expect(calls).toEqual(["append:a", "append:b"]);
    release();
    await Bun.sleep(80);
    release();
    await run;
    expect(calls).toEqual(["append:a", "append:b", "append:c"]);
  });

  test("aborting does not hang on rows the database never took", async () => {
    const { sink } = gatedSink();
    const abort = new AbortController();
    const run = appendFromSource(source([seg("a", 0, 1)]), sink, abort.signal);
    await Bun.sleep(20);
    abort.abort();
    expect(await run).toBe(1);
  });
});
