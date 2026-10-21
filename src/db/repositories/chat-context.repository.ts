import { and, eq, sql } from "drizzle-orm";
import type { Executor } from "../client";
import { chatContext, type ChatContext } from "../schema";
import { MutableRepository } from "./base.repository";

export type EpochStart = {
  frozenPrompt: string;
  promptHash: string;
  summaryUptoSeq?: number;
};

export class ChatContextRepository extends MutableRepository<typeof chatContext> {
  constructor(db: Executor) {
    super(db, chatContext);
  }

  get(chatId: string): Promise<ChatContext | null> {
    return this.findOne(eq(chatContext.chatId, chatId));
  }

  async ensure(chatId: string, init: EpochStart): Promise<ChatContext> {
    await this.insertIgnore(
      [
        {
          chatId,
          frozenPrompt: init.frozenPrompt,
          promptHash: init.promptHash,
          summaryUptoSeq: init.summaryUptoSeq ?? 0,
        },
      ],
      [chatContext.chatId],
    );
    const row = await this.get(chatId);
    if (!row) throw new Error(`context for chat ${chatId} vanished after ensure`);
    return row;
  }

  /** Starts the next epoch with a new frozen prompt (after compaction or a meeting-level change). */
  async startEpoch(chatId: string, next: EpochStart): Promise<ChatContext> {
    const rows = await this.updateWhere(eq(chatContext.chatId, chatId), {
      epoch: sql`${chatContext.epoch} + 1` as unknown as number,
      frozenPrompt: next.frozenPrompt,
      promptHash: next.promptHash,
      ...(next.summaryUptoSeq !== undefined ? { summaryUptoSeq: next.summaryUptoSeq } : {}),
      updatedAt: sql`now()` as unknown as Date,
    });
    const row = rows[0];
    if (!row) throw new Error(`no context for chat ${chatId}; call ensure first`);
    return row;
  }

  /**
   * startEpoch that only applies if the chat is still in `expectedEpoch`. Returns null when
   * another writer already moved on, so two processes compacting one chat start one epoch.
   */
  async startEpochIf(
    chatId: string,
    expectedEpoch: number,
    next: EpochStart,
  ): Promise<ChatContext | null> {
    const rows = await this.updateWhere(
      and(eq(chatContext.chatId, chatId), eq(chatContext.epoch, expectedEpoch))!,
      {
        epoch: expectedEpoch + 1,
        frozenPrompt: next.frozenPrompt,
        promptHash: next.promptHash,
        ...(next.summaryUptoSeq !== undefined ? { summaryUptoSeq: next.summaryUptoSeq } : {}),
        updatedAt: sql`now()` as unknown as Date,
      },
    );
    return rows[0] ?? null;
  }

  async setTopicState(chatId: string, topicState: Record<string, unknown>): Promise<void> {
    await this.updateWhere(eq(chatContext.chatId, chatId), {
      topicState,
      updatedAt: sql`now()` as unknown as Date,
    });
  }
}
