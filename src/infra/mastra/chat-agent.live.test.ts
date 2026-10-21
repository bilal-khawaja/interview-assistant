import { describe, expect, test } from "bun:test";
import type { ChatTurn } from "../../chat/agent";
import { DEFAULT_CHAT_SYSTEM_PROMPT } from "../../constants/chat";
import type { ChatMessage, TranscriptSegment } from "../../db/schema";
import { createChatAgent, createSummarizerAgent } from "../../mastra/agents";
import { MastraChatAgent, MastraChatSummarizer } from "./chat-agent";

/**
 * Calls the real model, so it only runs on request (a few cents at most):
 *   OPENAI_LIVE=1 bun test src/infra/mastra/chat-agent.live.test.ts
 */
const run = process.env.OPENAI_LIVE ? describe : describe.skip;

// OpenAI caches prompt prefixes of 1,024 tokens or more, so the frozen prompt is padded past that.
const PADDING = Array.from(
  { length: 160 },
  (_, i) => `Guideline ${i + 1}: keep suggestions short, factual and relevant to the live meeting.`,
).join("\n");

const segment = (seq: number, text: string) => ({ seq, text, speakerKey: "spk_0" }) as TranscriptSegment;
const message = (seq: number, role: ChatMessage["role"], content: string, kind: ChatMessage["kind"]) =>
  ({ seq, role, kind, content }) as ChatMessage;

const turn = (overrides: Partial<ChatTurn>): ChatTurn => ({
  trigger: "transcript",
  system: `${DEFAULT_CHAT_SYSTEM_PROMPT}\n\n${PADDING}`,
  dynamic: "",
  history: [],
  transcript: [],
  surfacedTerms: [],
  topicState: {},
  signal: new AbortController().signal,
  ...overrides,
});

run("real model", () => {
  const agent = new MastraChatAgent(createChatAgent());
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("a transcript turn returns the structured reply and real usage", async () => {
    const transcript = [
      segment(1, "So for the ingestion layer we decided to use Kafka with a Redis cache in front."),
      segment(2, "Fine, and the schema registry stays on Confluent."),
    ];
    const result = await agent.respond(turn({ transcript, dynamic: "Transcript:\n[1] spk_0: Kafka and Redis\n[2] spk_0: Confluent" }));
    console.log("TRANSCRIPT TURN", JSON.stringify(result, null, 2));
    expect(result.text === null || typeof result.text === "string").toBe(true);
    expect(Array.isArray(result.terms)).toBe(true);
    expect(result.usage.tokensIn).toBeGreaterThan(1000);
    expect(result.usage.tokensOut).toBeGreaterThan(0);
    expect(result.usage.costMicros).toBeGreaterThan(0);
  }, 60_000);

  test("a user turn answers the question", async () => {
    const result = await agent.respond(
      turn({
        trigger: "user",
        history: [message(1, "user", "What did they decide for the ingestion layer?", "followup")],
        dynamic: "Transcript:\n[1] spk_0: we decided to use Kafka with a Redis cache in front.",
      }),
    );
    console.log("USER TURN", JSON.stringify(result, null, 2));
    expect(result.text).toBeTruthy();
    expect(result.text!.toLowerCase()).toContain("kafka");
  }, 60_000);

  test("repeating a long identical prefix reads from the provider cache", async () => {
    const same = () => turn({ dynamic: "Transcript:\n[1] spk_0: We will migrate billing to Stripe next quarter." });
    const first = await agent.respond(same());
    await sleep(3_000);
    const second = await agent.respond(same());
    console.log("CACHE FIRST", JSON.stringify(first.usage), "SECOND", JSON.stringify(second.usage));
    expect(second.usage.tokensIn).toBeGreaterThan(1000);
    // Informational: OpenAI decides when a prefix is cached, so a miss is reported, not failed.
    if (second.usage.tokensCacheRead === 0) console.log("NO CACHE READ on the second call");
  }, 90_000);
});

run("real summarizer", () => {
  test("follows the fixed template", async () => {
    const summarizer = new MastraChatSummarizer(createSummarizerAgent());
    const { buildSummaryPrompt } = await import("../../chat/compaction");
    const prompt = buildSummaryPrompt(null, [
      message(1, "user", "What did they decide about ingestion?", "followup"),
      message(2, "assistant", "They chose Kafka with a Redis cache.", "reply"),
      message(3, "user", "Remind me to ask about the schema registry.", "followup"),
    ]);
    const result = await summarizer.summarize(prompt);
    console.log("SUMMARY", result.text, JSON.stringify(result.usage));
    for (const heading of ["## Goal", "## Decisions and facts", "## Open questions", "## User requests"]) {
      expect(result.text).toContain(heading);
    }
    expect(result.text.toLowerCase()).toContain("kafka");
    expect(result.usage.tokensIn).toBeGreaterThan(0);
  }, 60_000);
});
