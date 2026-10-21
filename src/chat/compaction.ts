import {
  CHAT_COMPACT_AFTER_MESSAGES,
  CHAT_COMPACT_AFTER_TOKENS,
  CHAT_COMPACT_KEEP_MESSAGES,
} from "../constants/chat";
import type { Database } from "../db/client";
import { ChatBudgetRepository } from "../db/repositories/chat-budget.repository";
import { ChatContextRepository } from "../db/repositories/chat-context.repository";
import { ChatMessageRepository } from "../db/repositories/chat-message.repository";
import type { ChatMessage } from "../db/schema";
import type { ChatSummarizer } from "./agent";
import { derivedId } from "./ids";

export type CompactionConfig = {
  afterMessages?: number;
  afterTokens?: number;
  keepMessages?: number;
};

/** Fixed template: every summary has the same sections, so later summaries can build on earlier ones. */
export const SUMMARY_TEMPLATE = [
  "## Goal",
  "What the participant is trying to get out of this meeting.",
  "## Decisions and facts",
  "Concrete things stated or decided, one per line.",
  "## Open questions",
  "Questions asked and not yet answered.",
  "## User requests",
  "Standing requests from the participant that still apply.",
].join("\n");

export function buildSummaryPrompt(previousSummary: string | null, messages: ChatMessage[]): string {
  const lines = messages.map((m) => `[${m.seq}] ${m.role}/${m.kind}: ${m.content}`);
  return [
    "Summarize this meeting-assistant chat so the older messages can be dropped.",
    "Reply with exactly these sections, in this order, and nothing else:",
    SUMMARY_TEMPLATE,
    "Keep every name, number and commitment. Do not list the terms already pointed out; they are tracked separately.",
    previousSummary ? `Previous summary (fold it in):\n${previousSummary}` : "",
    `Messages to fold:\n${lines.join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Rough size of a message in tokens; the provider's own count is not available before the call. */
export function estimateTokens(messages: ChatMessage[]): number {
  return Math.ceil(messages.reduce((sum, m) => sum + m.content.length, 0) / 4);
}

/** Same chat and epoch always give the same id, so a repeated compaction finds its summary row. */
export function summaryMessageId(chatId: string, epoch: number): string {
  return derivedId("chat-summary", chatId, epoch);
}

class LostEpochRace extends Error {}

/**
 * Folds old messages into one summary and starts a new epoch. Call it from inside the
 * chat's coordinator slot. The summary, the new epoch and the budget charge commit together;
 * surfaced terms live in their own table and are never touched.
 */
export class ChatCompactor {
  private readonly afterMessages: number;
  private readonly afterTokens: number;
  private readonly keepMessages: number;

  constructor(
    private readonly db: Database,
    private readonly summarizer: ChatSummarizer,
    config: CompactionConfig = {},
  ) {
    this.afterMessages = config.afterMessages ?? CHAT_COMPACT_AFTER_MESSAGES;
    this.afterTokens = config.afterTokens ?? CHAT_COMPACT_AFTER_TOKENS;
    this.keepMessages = config.keepMessages ?? CHAT_COMPACT_KEEP_MESSAGES;
  }

  /** Returns true if the chat was compacted. */
  async compactIfNeeded(chatId: string): Promise<boolean> {
    const contexts = new ChatContextRepository(this.db);
    const messages = new ChatMessageRepository(this.db);
    const context = await contexts.get(chatId);
    if (!context) return false;

    const live = (await messages.listAfter(chatId, context.summaryUptoSeq, Number.MAX_SAFE_INTEGER)).filter(
      (m) => m.role !== "summary",
    );
    if (live.length <= this.keepMessages) return false;
    if (live.length < this.afterMessages && estimateTokens(live) < this.afterTokens) return false;
    // A summary appended after an unanswered user message would hide it from recovery.
    const [latest] = await messages.tail(chatId, 1);
    if (latest?.role === "user") return false;
    if ((await new ChatBudgetRepository(this.db).remaining(chatId)) <= 0) return false;

    const folded = live.slice(0, -this.keepMessages);
    const uptoSeq = folded.at(-1)!.seq;
    const previous = await messages.latestSummary(chatId);
    const result = await this.summarizer.summarize(buildSummaryPrompt(previous?.content ?? null, folded));
    const { usage } = result;

    try {
      await this.db.transaction(async (tx) => {
        const next = await new ChatContextRepository(tx).startEpochIf(chatId, context.epoch, {
          frozenPrompt: context.frozenPrompt,
          promptHash: context.promptHash,
          summaryUptoSeq: uptoSeq,
        });
        if (!next) throw new LostEpochRace();
        await new ChatMessageRepository(tx).append(chatId, {
          id: summaryMessageId(chatId, context.epoch),
          role: "summary",
          kind: "summary",
          content: result.text,
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          tokensCacheRead: usage.tokensCacheRead ?? 0,
          tokensCacheWrite: usage.tokensCacheWrite ?? 0,
        });
        await new ChatBudgetRepository(tx).charge(chatId, usage.tokensIn + usage.tokensOut, usage.costMicros);
      });
    } catch (error) {
      if (error instanceof LostEpochRace) return false;
      throw error;
    }
    return true;
  }
}
