import type { Agent } from "@mastra/core/agent";
import type { ModelMessage } from "ai";
import { z } from "zod";
import { CHAT_MODEL_PRICING, type ModelPricing } from "../../constants/models";
import type { ChatMessage } from "../../db/schema";
import type {
  ChatAgent,
  ChatAgentResult,
  ChatSummarizer,
  ChatTurn,
  ChatUsage,
  SummaryResult,
} from "../../chat/agent";

type GenerateAgent = Pick<Agent, "generate">;

const replySchema = z.object({
  text: z.string().nullable().describe("The message to show, or null when there is nothing worth saying."),
  terms: z.array(z.string()).describe("Terms or topics the text points out; empty for a plain answer."),
});

const TRANSCRIPT_INSTRUCTION =
  "New transcript segments arrived. If a term or topic is worth pointing out and is not in the surfaced list, " +
  "write a short suggestion and list the terms it points out. Otherwise reply with text null and no terms.";
const USER_INSTRUCTION =
  "Answer the participant's latest message using the context above. Leave terms empty unless you point one out.";

type RawUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  raw?: unknown;
};

/**
 * Maps provider usage to the chat columns. tokensIn is the full prompt size, cached tokens
 * included, so a cache hit lowers the cost but not the token budget. Cache read/write
 * come from the provider's nested usage when present, else from the flat fields.
 */
export function toChatUsage(usage: RawUsage, pricing: ModelPricing = CHAT_MODEL_PRICING): ChatUsage {
  const nested = (usage.raw as { inputTokens?: { cacheRead?: number; cacheWrite?: number } } | undefined)?.inputTokens;
  const tokensIn = usage.inputTokens ?? 0;
  const tokensOut = usage.outputTokens ?? 0;
  const tokensCacheRead = nested?.cacheRead ?? usage.cachedInputTokens ?? 0;
  const tokensCacheWrite = nested?.cacheWrite ?? usage.cacheCreationInputTokens ?? 0;
  const uncached = Math.max(0, tokensIn - tokensCacheRead);
  const costMicros = Math.round(
    uncached * pricing.input + tokensCacheRead * pricing.cachedInput + tokensOut * pricing.output,
  );
  return { tokensIn, tokensOut, tokensCacheRead, tokensCacheWrite, costMicros };
}

/** Prompt order is system (frozen), history, then the changing context, so the stable prefix stays cacheable. */
export function toModelMessages(turn: ChatTurn): ModelMessage[] {
  const history = turn.history.flatMap((message) => {
    const mapped = historyMessage(message);
    return mapped ? [mapped] : [];
  });
  const closing = [turn.dynamic, turn.trigger === "user" ? USER_INSTRUCTION : TRANSCRIPT_INSTRUCTION]
    .filter(Boolean)
    .join("\n\n");
  return [...history, { role: "user", content: closing }];
}

function historyMessage(message: ChatMessage): ModelMessage | null {
  switch (message.role) {
    case "user":
      return { role: "user", content: message.content };
    case "assistant":
      return { role: "assistant", content: message.content };
    case "summary":
      return { role: "user", content: `Summary of the earlier conversation:\n${message.content}` };
    default:
      return null;
  }
}

export class MastraChatAgent implements ChatAgent {
  constructor(
    private readonly agent: GenerateAgent,
    private readonly pricing: ModelPricing = CHAT_MODEL_PRICING,
  ) {}

  async respond(turn: ChatTurn): Promise<ChatAgentResult> {
    const result = await this.agent.generate(toModelMessages(turn), {
      instructions: turn.system,
      structuredOutput: { schema: replySchema },
      abortSignal: turn.signal,
    });
    const reply = replySchema.parse(result.object);
    return {
      text: reply.text?.trim() || null,
      terms: reply.terms,
      usage: toChatUsage(result.totalUsage ?? result.usage, this.pricing),
    };
  }
}

export class MastraChatSummarizer implements ChatSummarizer {
  constructor(
    private readonly agent: GenerateAgent,
    private readonly pricing: ModelPricing = CHAT_MODEL_PRICING,
  ) {}

  async summarize(prompt: string): Promise<SummaryResult> {
    const result = await this.agent.generate(prompt);
    const text = result.text.trim();
    if (!text) throw new Error("summarizer returned no text");
    return { text, usage: toChatUsage(result.totalUsage ?? result.usage, this.pricing) };
  }
}
