import { describe, expect, test } from "bun:test";
import { MergedSource } from "./merged-source";
import type { SourceSegment, TranscriptSource } from "./source";

/** Yields what it is told to, when it is told to, and ends when closed or aborted. */
class ManualSource implements TranscriptSource {
  private readonly items: SourceSegment[] = [];
  private closed = false;
  private wake: (() => void) | null = null;
  failWith: Error | null = null;

  say(text: string, startMs = 0): void {
    this.items.push({ text, startMs, endMs: startMs + 1 });
    this.poke();
  }
  close(): void {
    this.closed = true;
    this.poke();
  }
  fail(error: Error): void {
    this.failWith = error;
    this.poke();
  }
  private poke(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
  async *stream(signal: AbortSignal): AsyncGenerator<SourceSegment> {
    for (;;) {
      const next = this.items.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.failWith) throw this.failWith;
      if (this.closed || signal.aborted) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  }
}

async function collect(merged: MergedSource, signal = new AbortController().signal) {
  const out: SourceSegment[] = [];
  for await (const segment of merged.stream(signal)) out.push(segment);
  return out;
}

describe("MergedSource", () => {
  test("stamps each source's segments with its speaker and ends when the primary ends", async () => {
    const primary = new ManualSource();
    const guest = new ManualSource();
    const merged = new MergedSource({ source: primary, speakerKey: "user:a" });
    const done = collect(merged);

    primary.say("one");
    await Bun.sleep(10);
    expect(merged.add(guest, "user:b")).toBe(true);
    guest.say("two");
    await Bun.sleep(10);
    primary.say("three");
    primary.close();

    expect((await done).map((s) => [s.text, s.speakerKey])).toEqual([
      ["one", "user:a"],
      ["two", "user:b"],
      ["three", "user:a"],
    ]);
  });

  test("a child that ends or fails leaves the rest running, and is reported", async () => {
    const primary = new ManualSource();
    const ended = new ManualSource();
    const broken = new ManualSource();
    const reported: [TranscriptSource, unknown][] = [];
    const merged = new MergedSource({ source: primary, speakerKey: null }, (source, error) =>
      reported.push([source, error]),
    );
    const done = collect(merged);
    await Bun.sleep(10);

    merged.add(ended, "user:b");
    merged.add(broken, "user:c");
    ended.say("b says");
    ended.close();
    broken.fail(new Error("boom"));
    await Bun.sleep(30);
    expect(merged.size).toBe(0);
    expect(reported.find(([source]) => source === ended)?.[1]).toBeUndefined();
    expect((reported.find(([source]) => source === broken)?.[1] as Error).message).toBe("boom");

    primary.say("still here");
    primary.close();
    const out = await done;
    expect(out.map((s) => s.text)).toEqual(["b says", "still here"]);
    expect(out[1]?.speakerKey).toBeUndefined();
  });

  test("when the primary ends the children are stopped, and nothing can be added any more", async () => {
    const primary = new ManualSource();
    const guest = new ManualSource();
    const merged = new MergedSource({ source: primary, speakerKey: null });
    const done = collect(merged);
    await Bun.sleep(10);
    merged.add(guest, "user:b");

    primary.close();
    await done;
    await Bun.sleep(10);
    expect(merged.size).toBe(0);
    expect(merged.add(new ManualSource(), "user:c")).toBe(false);
  });

  test("a failing primary fails the stream after what was queued is delivered", async () => {
    const primary = new ManualSource();
    const merged = new MergedSource({ source: primary, speakerKey: null });
    const out: string[] = [];
    const done = (async () => {
      for await (const segment of merged.stream(new AbortController().signal)) out.push(segment.text);
    })();
    primary.say("last words");
    primary.fail(new Error("primary down"));
    await expect(done).rejects.toThrow("primary down");
    expect(out).toEqual(["last words"]);
  });

  test("aborting the signal ends the stream and stops the children", async () => {
    const controller = new AbortController();
    const primary = new ManualSource();
    const guest = new ManualSource();
    const merged = new MergedSource({ source: primary, speakerKey: null });
    const done = collect(merged, controller.signal);
    await Bun.sleep(10);
    merged.add(guest, "user:b");
    controller.abort();
    await done;
    await Bun.sleep(10);
    expect(merged.size).toBe(0);
  });

  test("add before the stream starts is refused", () => {
    const merged = new MergedSource({ source: new ManualSource(), speakerKey: null });
    expect(merged.add(new ManualSource(), "user:b")).toBe(false);
  });
});
