import { describe, expect, test } from "bun:test";
import type { TranscriptSegment } from "../db/schema";
import type { Delivery } from "./consumer";
import { dedupeHandler } from "./dedupe";

function delivery(...seqs: number[]): Delivery {
  return {
    meetingId: "m",
    chatId: "c",
    attempt: 1,
    segments: seqs.map(
      (seq) =>
        ({
          id: seq,
          meetingId: "m",
          seq,
          speakerKey: null,
          text: `s${seq}`,
          startMs: 0,
          endMs: 0,
          source: "stt",
          createdAt: new Date(0),
        }) satisfies TranscriptSegment,
    ),
  };
}

describe("dedupeHandler", () => {
  test("passes new segments once and drops an exact redelivery", async () => {
    const got: number[][] = [];
    const handler = dedupeHandler(async (d) => void got.push(d.segments.map((s) => s.seq)));
    await handler(delivery(1, 2, 3));
    await handler(delivery(1, 2, 3));
    expect(got).toEqual([[1, 2, 3]]);
  });

  test("a partially overlapping redelivery only passes the unseen tail", async () => {
    const got: number[][] = [];
    const handler = dedupeHandler(async (d) => void got.push(d.segments.map((s) => s.seq)));
    await handler(delivery(1, 2));
    await handler(delivery(2, 3, 4));
    expect(got).toEqual([[1, 2], [3, 4]]);
  });

  test("a failing handler does not advance the watermark, so the retry is not dropped", async () => {
    const got: number[][] = [];
    let fail = true;
    const handler = dedupeHandler(async (d) => {
      if (fail) {
        fail = false;
        throw new Error("boom");
      }
      got.push(d.segments.map((s) => s.seq));
    });
    await expect(handler(delivery(1, 2))).rejects.toThrow("boom");
    await handler(delivery(1, 2));
    expect(got).toEqual([[1, 2]]);
  });

  test("starts after an initial watermark", async () => {
    const got: number[][] = [];
    const handler = dedupeHandler(async (d) => void got.push(d.segments.map((s) => s.seq)), 5);
    await handler(delivery(4, 5, 6));
    expect(got).toEqual([[6]]);
  });
});
