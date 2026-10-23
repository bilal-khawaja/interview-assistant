import { eq, sql } from "drizzle-orm";
import type { Executor } from "../client";
import { chatBudget, type ChatBudget } from "../schema";
import { MutableRepository } from "./base.repository";

export class ChatBudgetRepository extends MutableRepository<typeof chatBudget> {
  constructor(db: Executor) {
    super(db, chatBudget);
  }

  get(chatId: string): Promise<ChatBudget | null> {
    return this.findOne(eq(chatBudget.chatId, chatId));
  }

  /** Creates the budget on first use; an existing budget keeps its limit and usage. */
  async ensure(chatId: string, tokenLimit: number): Promise<ChatBudget> {
    await this.insertIgnore([{ chatId, tokenLimit }], [chatBudget.chatId]);
    const row = await this.get(chatId);
    if (!row) throw new Error(`budget for chat ${chatId} vanished after ensure`);
    return row;
  }

  /** Adds usage in one atomic statement, so concurrent turns cannot lose an update. */
  async charge(chatId: string, tokens: number, costMicros = 0): Promise<ChatBudget> {
    const rows = await this.updateWhere(eq(chatBudget.chatId, chatId), {
      tokensUsed: sql`${chatBudget.tokensUsed} + ${tokens}` as unknown as number,
      costMicros: sql`${chatBudget.costMicros} + ${costMicros}` as unknown as number,
      updatedAt: sql`now()` as unknown as Date,
    });
    const row = rows[0];
    if (!row) throw new Error(`no budget for chat ${chatId}; call ensure first`);
    return row;
  }

  async remaining(chatId: string): Promise<number> {
    const row = await this.get(chatId);
    if (!row) throw new Error(`no budget for chat ${chatId}; call ensure first`);
    return Math.max(0, row.tokenLimit - row.tokensUsed);
  }

  async setLimit(chatId: string, tokenLimit: number): Promise<ChatBudget | null> {
    const rows = await this.updateWhere(eq(chatBudget.chatId, chatId), {
      tokenLimit,
      updatedAt: sql`now()` as unknown as Date,
    });
    return rows[0] ?? null;
  }
}
