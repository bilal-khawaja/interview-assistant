import { describe, expect, test } from "bun:test";
import { MockLanguageModelV4 } from "ai/test";
import { createChatAgent, createSummarizerAgent } from "../../mastra/agents";
import type { ChatTurn } from "../../chat/agent";
import type { ChatMessage, TranscriptSegment } from "../../db/schema";
import { MastraChatAgent, MastraChatSummarizer, toChatUsage, toModelMessages } from "./chat-agent";

type Seen = { prompt?: unknown };

function mockModel(text: string, seen: Seen = {}, cache = { cacheRead: 600, cacheWrite: 0 }) {
  return new MockLanguageModelV4({
    doGenerate: async (options: { prompt: unknown }) => {
      seen.prompt = options.prompt;
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1000, noCache: 1000 - cache.cacheRead, ...cache },
          outputTokens: { total: 50, text: 50, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
}

const message = (seq: number, role: ChatMessage["role"], content: string, kind: ChatMessage["kind"] = "reply"): ChatMessage =>
  ({ seq, role, kind, content }) as ChatMessage;

const turn = (overrides: Partial<ChatTurn> = {}): ChatTurn => ({
  trigger: "user",
  system: "FROZEN SYSTEM",
  dynamic: "Transcript:\n[3] a: hello",
  history: [message(1, "user", "what is Kafka?", "followup")],
  transcript: [] as TranscriptSegment[],
  surfacedTerms: [],
  topicState: {},
  signal: new AbortController().signal,
  ...overrides,
});

describe("toModelMessages", () => {
  test("maps roles, turns a summary into context, drops notices, puts the dynamic block last", () => {
    const messages = toModelMessages(
      turn({
        history: [
          message(1, "summary", "## Goal\nx", "summary"),
          message(2, "user", "q", "followup"),
          message(3, "system", "budget gone", "notice"),
          message(4, "assistant", "a"),
        ],
      }),
    );
    expect(messages.map((m) => m.role)).toEqual(["user", "user", "assistant", "user"]);
    expect(String(messages[0]!.content)).toContain("Summary of the earlier conversation");
    expect(String(messages.at(-1)!.content)).toContain("Transcript:\n[3] a: hello");
    expect(JSON.stringify(messages)).not.toContain("budget gone");
  });

  test("the closing instruction depends on the trigger", () => {
    expect(String(toModelMessages(turn()).at(-1)!.content)).toContain("Answer the participant's latest message");
    expect(String(toModelMessages(turn({ trigger: "transcript" })).at(-1)!.content)).toContain("New transcript segments");
  });
});

describe("toChatUsage", () => {
  test("reads cache read/write from the nested provider usage and prices cached input lower", () => {
    const usage = toChatUsage(
      { inputTokens: 1000, outputTokens: 50, raw: { inputTokens: { cacheRead: 600, cacheWrite: 20 } } },
      { input: 1, cachedInput: 0.5, output: 2 },
    );
    expect(usage).toMatchObject({ tokensIn: 1000, tokensOut: 50, tokensCacheRead: 600, tokensCacheWrite: 20 });
    expect(usage.costMicros).toBe(400 * 1 + 600 * 0.5 + 50 * 2);
  });

  test("falls back to the flat fields and zeroes when usage is missing", () => {
    expect(toChatUsage({ inputTokens: 10, outputTokens: 1, cachedInputTokens: 4, cacheCreationInputTokens: 2 })).toMatchObject({
      tokensCacheRead: 4,
      tokensCacheWrite: 2,
    });
    expect(toChatUsage({})).toMatchObject({ tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0, costMicros: 0 });
  });
});

describe("MastraChatAgent", () => {
  test("returns the structured reply with usage including cache reads", async () => {
    const seen: Seen = {};
    const agent = new MastraChatAgent(
      createChatAgent(mockModel(JSON.stringify({ text: "Kafka is a log", terms: ["Kafka"] }), seen) as never),
    );
    const result = await agent.respond(turn());
    expect(result.text).toBe("Kafka is a log");
    expect(result.terms).toEqual(["Kafka"]);
    expect(result.usage).toMatchObject({ tokensIn: 1000, tokensOut: 50, tokensCacheRead: 600 });
    expect(result.usage.costMicros).toBeGreaterThan(0);
    const prompt = JSON.stringify(seen.prompt);
    expect(prompt).toContain("FROZEN SYSTEM");
    expect(prompt).toContain("what is Kafka?");
    expect(prompt).toContain("[3] a: hello");
    expect(prompt.indexOf("FROZEN SYSTEM")).toBeLessThan(prompt.indexOf("what is Kafka?"));
    expect(prompt.indexOf("what is Kafka?")).toBeLessThan(prompt.indexOf("[3] a: hello"));
  });

  test("null or blank text means nothing worth saying", async () => {
    for (const text of [null, "   "]) {
      const agent = new MastraChatAgent(createChatAgent(mockModel(JSON.stringify({ text, terms: [] })) as never));
      expect((await agent.respond(turn({ trigger: "transcript" }))).text).toBeNull();
    }
  });

  test("an aborted signal rejects the call", async () => {
    const controller = new AbortController();
    controller.abort();
    const agent = new MastraChatAgent(createChatAgent(mockModel(JSON.stringify({ text: "x", terms: [] })) as never));
    await expect(agent.respond(turn({ signal: controller.signal }))).rejects.toThrow();
  });
});

describe("MastraChatSummarizer", () => {
  test("returns the trimmed summary with usage", async () => {
    const seen: Seen = {};
    const summarizer = new MastraChatSummarizer(createSummarizerAgent(mockModel("  ## Goal\nship  ", seen) as never));
    const result = await summarizer.summarize("fold these");
    expect(result.text).toBe("## Goal\nship");
    expect(result.usage.tokensIn).toBe(1000);
    expect(JSON.stringify(seen.prompt)).toContain("fold these");
  });

  test("an empty summary is an error", async () => {
    const summarizer = new MastraChatSummarizer(createSummarizerAgent(mockModel("  ") as never));
    await expect(summarizer.summarize("x")).rejects.toThrow("no text");
  });
});
