import { describe, expect, test } from "bun:test";
import type { TranscriptSegment } from "../db/schema";
import { buildFrozenPrompt, hashPrompt, renderDynamicContext } from "./context";

const segment = (seq: number, text: string, speakerKey: string | null = "a"): TranscriptSegment =>
  ({ seq, text, speakerKey }) as TranscriptSegment;

describe("frozen prompt", () => {
  test("is deterministic and carries the meeting title", () => {
    expect(buildFrozenPrompt("base", " Standup ")).toBe("base\n\nMeeting: Standup");
    expect(buildFrozenPrompt("base", "Standup")).toBe(buildFrozenPrompt("base", "Standup"));
  });

  test("is the bare prompt when the meeting has no title", () => {
    expect(buildFrozenPrompt("base", "  ")).toBe("base");
  });

  test("hash changes with the prompt", async () => {
    expect(await hashPrompt("a")).toBe(await hashPrompt("a"));
    expect(await hashPrompt("a")).not.toBe(await hashPrompt("b"));
  });
});

describe("dynamic context", () => {
  test("is empty when nothing has happened", () => {
    expect(renderDynamicContext({ surfacedTerms: [], topicState: {}, transcript: [] })).toBe("");
  });

  test("lists terms, topic state and transcript, in that order", () => {
    const text = renderDynamicContext({
      surfacedTerms: ["Kafka"],
      topicState: { topic: "infra" },
      transcript: [segment(3, "we use Kafka"), segment(4, "and Redis", null)],
    });
    expect(text.indexOf("Kafka\n")).toBeLessThan(text.indexOf("Topic state"));
    expect(text.indexOf("Topic state")).toBeLessThan(text.indexOf("Transcript"));
    expect(text).toContain("[3] a: we use Kafka");
    expect(text).toContain("[4] ?: and Redis");
  });
});
