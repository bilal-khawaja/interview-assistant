import { describe, expect, test } from "bun:test";
import { AsyncQueue, QueueOverflowError } from "./async-queue";
import { deepgramUrl, isCleanClose, parseDeepgramMessage } from "./deepgram";

const result = (overrides: Record<string, unknown> = {}) => ({
  type: "Results",
  is_final: true,
  start: 1.5,
  duration: 2.25,
  channel: {
    alternatives: [
      {
        transcript: " Hello there ",
        words: [{ speaker: 1 }, { speaker: 1 }, { speaker: 0 }],
      },
    ],
  },
  ...overrides,
});

describe("parseDeepgramMessage", () => {
  test("maps a final result to a segment with offset timing and dominant speaker", () => {
    expect(parseDeepgramMessage(result(), 10_000)).toEqual([
      {
        text: "Hello there",
        startMs: 11_500,
        endMs: 13_750,
        speakerKey: "spk_1",
        source: "deepgram",
      },
    ]);
  });

  test("ignores interim results, empty transcripts and other message types", () => {
    expect(parseDeepgramMessage(result({ is_final: false }), 0)).toEqual([]);
    expect(
      parseDeepgramMessage(
        result({ channel: { alternatives: [{ transcript: "  ", words: [] }] } }),
        0,
      ),
    ).toEqual([]);
    expect(parseDeepgramMessage({ type: "Metadata" }, 0)).toEqual([]);
    expect(parseDeepgramMessage(null, 0)).toEqual([]);
  });

  test("speaker is null when words carry no diarization", () => {
    const message = result({
      channel: { alternatives: [{ transcript: "hi", words: [{}] }] },
    });
    expect(parseDeepgramMessage(message, 0)[0]?.speakerKey).toBeNull();
  });
});

describe("parseDeepgramMessage speaker changes", () => {
  const w = (word: string, start: number, end: number, speaker?: number) => ({
    word: word.toLowerCase(),
    punctuated_word: word,
    start,
    end,
    ...(speaker === undefined ? {} : { speaker }),
  });
  const message = (words: ReturnType<typeof w>[]) =>
    result({
      start: 0,
      duration: 4,
      channel: { alternatives: [{ transcript: words.map((x) => x.punctuated_word).join(" "), words }] },
    });

  test("splits one result into a segment per speaker change, with word-level timing", () => {
    const out = parseDeepgramMessage(
      message([w("Hi", 0, 0.4, 0), w("there.", 0.4, 1, 0), w("Hello", 1.2, 1.6, 1), w("back.", 1.6, 2, 1), w("Okay", 2.2, 2.6, 0)]),
      1_000,
    );
    expect(out).toEqual([
      { text: "Hi there.", startMs: 1_000, endMs: 2_000, speakerKey: "spk_0", source: "deepgram" },
      { text: "Hello back.", startMs: 2_200, endMs: 3_000, speakerKey: "spk_1", source: "deepgram" },
      { text: "Okay", startMs: 3_200, endMs: 3_600, speakerKey: "spk_0", source: "deepgram" },
    ]);
  });

  test("a word with no speaker label stays with the run it sits in", () => {
    const out = parseDeepgramMessage(
      message([w("One", 0, 0.5, 0), w("two", 0.5, 1), w("three", 1, 1.5, 1)]),
      0,
    );
    expect(out.map((s) => [s.text, s.speakerKey])).toEqual([
      ["One two", "spk_0"],
      ["three", "spk_1"],
    ]);
  });

  test("a single speaker, or words without text or timing, stays one segment", () => {
    expect(parseDeepgramMessage(message([w("a", 0, 1, 2), w("b", 1, 2, 2)]), 0)).toHaveLength(1);
    expect(parseDeepgramMessage(result(), 0)).toHaveLength(1); // fixture words have only speaker
  });
});

describe("parseDeepgramMessage notBeforeMs", () => {
  const w = (word: string, start: number, end: number, speaker = 0) => ({
    word,
    punctuated_word: word,
    start,
    end,
    speaker,
  });
  const message = (words: ReturnType<typeof w>[]) => ({
    type: "Results",
    is_final: true,
    start: 0,
    duration: 4,
    channel: { alternatives: [{ transcript: words.map((x) => x.word).join(" "), words }] },
  });

  test("drops words that started before the cutoff and keeps the rest with their timing", () => {
    // base 1_000: words at 1.0, 1.5, 2.0, 2.5 s. Everything before 2_000 ms is already stored.
    const out = parseDeepgramMessage(
      message([w("old", 0, 0.4), w("older", 0.5, 0.9), w("new", 1.0, 1.4), w("newer", 1.5, 2)]),
      1_000,
      2_000,
    );
    expect(out).toEqual([
      { text: "new newer", startMs: 2_000, endMs: 3_000, speakerKey: "spk_0", source: "deepgram" },
    ]);
  });

  test("a result made only of old words is dropped, and an untimed one is judged by its end", () => {
    expect(parseDeepgramMessage(message([w("old", 0, 0.4)]), 1_000, 5_000)).toEqual([]);
    const untimed = { type: "Results", is_final: true, start: 0, duration: 1, channel: { alternatives: [{ transcript: "x", words: [{ speaker: 0 }] }] } };
    expect(parseDeepgramMessage(untimed, 1_000, 5_000)).toEqual([]);
    expect(parseDeepgramMessage(untimed, 1_000, 1_500)).toHaveLength(1);
  });

  test("without a cutoff nothing is trimmed", () => {
    expect(parseDeepgramMessage(message([w("a", 0, 0.4), w("b", 0.5, 1)]), 0)[0]!.text).toBe("a b");
  });
});

describe("deepgramUrl", () => {
  test("lets Deepgram detect the container and asks for diarized final results only", () => {
    const url = new URL(deepgramUrl({ apiKey: "k" }));
    expect(url.host).toBe("api.deepgram.com");
    expect(url.searchParams.has("encoding")).toBe(false);
    expect(url.searchParams.has("sample_rate")).toBe(false);
    expect(url.searchParams.get("diarize")).toBe("true");
    expect(url.searchParams.get("interim_results")).toBe("false");
  });

  test("declares headerless PCM when asked, so a reconnect can resume mid-stream", () => {
    const url = new URL(deepgramUrl({ apiKey: "k", pcm: { sampleRate: 16_000 } }));
    expect(url.searchParams.get("encoding")).toBe("linear16");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
    expect(url.searchParams.get("channels")).toBe("1");
  });
});

describe("AsyncQueue", () => {
  test("yields pushed items in order and ends on close", async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    setTimeout(() => {
      queue.push(3);
      queue.close();
    }, 10);
    const got: number[] = [];
    for await (const item of queue) got.push(item);
    expect(got).toEqual([1, 2, 3]);
  });

  test("drains queued items before surfacing a failure", async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.close(new Error("boom"));
    const got: number[] = [];
    await expect(
      (async () => {
        for await (const item of queue) got.push(item);
      })(),
    ).rejects.toThrow("boom");
    expect(got).toEqual([1]);
  });
});

describe("AsyncQueue capacity", () => {
  test("rejects the push that exceeds capacity, drains what fit, then fails", async () => {
    const queue = new AsyncQueue<number>(2);
    expect(queue.push(1)).toBe(true);
    expect(queue.push(2)).toBe(true);
    expect(queue.size).toBe(2);
    expect(queue.push(3)).toBe(false);
    expect(queue.push(4)).toBe(false);
    const got: number[] = [];
    await expect(
      (async () => {
        for await (const item of queue) got.push(item);
      })(),
    ).rejects.toBeInstanceOf(QueueOverflowError);
    expect(got).toEqual([1, 2]);
  });
});

describe("isCleanClose", () => {
  test("normal closes are clean", () => {
    expect(isCleanClose(1000, false)).toBe(true);
    expect(isCleanClose(1005, false)).toBe(true);
  });

  test("a dropped connection is clean only after we asked to close", () => {
    expect(isCleanClose(1006, false)).toBe(false);
    expect(isCleanClose(1006, true)).toBe(true);
  });

  test("server errors are never clean unless we initiated the close", () => {
    expect(isCleanClose(1011, false)).toBe(false);
  });
});
