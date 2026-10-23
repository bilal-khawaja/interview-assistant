import { describe, expect, test } from "bun:test";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { createAnswererAgent } from "../../mastra/agents";
import { AnswerWriter } from "./answer-writer";

function mockModel(deltas: string[], seen: { prompt?: unknown } = {}) {
  return new MockLanguageModelV4({
    doStream: async (options: { prompt: unknown }) => {
      seen.prompt = options.prompt;
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "1" },
            ...deltas.map((delta) => ({ type: "text-delta", id: "1", delta })),
            { type: "text-end", id: "1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 1_000_000, noCache: 1_000_000 },
                outputTokens: { total: 1_000_000, text: 1_000_000 },
              },
            },
          ] as never,
        }),
      };
    },
  });
}

const evidence = [
  { documentId: "d", chunkIndex: 2, content: "alpha", relevance: 0.9 },
  { documentId: "d", chunkIndex: 5, content: "beta", relevance: 0.8 },
];

describe("AnswerWriter", () => {
  test("streams tokens in order and maps usage and cost", async () => {
    const writer = new AnswerWriter(
      createAnswererAgent(mockModel(["he", "llo"]) as never),
    );
    const answer = writer.write("q?", evidence);

    const tokens: string[] = [];
    for await (const token of answer.tokens) tokens.push(token);

    expect(tokens.join("")).toBe("hello");
    const usage = await answer.usage();
    expect(usage.inputTokens).toBe(1_000_000);
    expect(usage.outputTokens).toBe(1_000_000);
    expect(usage.totalTokens).toBe(2_000_000);
  });

  test("puts chunk indexes, content and the question in the prompt", async () => {
    const seen: { prompt?: unknown } = {};
    const writer = new AnswerWriter(
      createAnswererAgent(mockModel(["x"], seen) as never),
    );
    const answer = writer.write("what is beta?", evidence);
    for await (const _ of answer.tokens) void _;

    const prompt = JSON.stringify(seen.prompt);
    expect(prompt).toContain("[chunk 2] alpha");
    expect(prompt).toContain("[chunk 5] beta");
    expect(prompt).toContain("Question: what is beta?");
  });

  test("an empty answer yields no tokens", async () => {
    const writer = new AnswerWriter(createAnswererAgent(mockModel([]) as never));
    const tokens: string[] = [];
    for await (const token of writer.write("q", evidence).tokens) tokens.push(token);
    expect(tokens).toEqual([]);
  });
});
