import { and, asc, desc, eq, gt, max, sql } from "drizzle-orm";
import type { Executor } from "../client";
import {
  chatMessages,
  type ChatMessage,
  type ChatMessageKind,
  type ChatMessageRole,
} from "../schema";
import { BaseRepository } from "./base.repository";

export type ChatMessageDraft = {
  /** Supply the inbox message id for user messages so a retried promotion finds its row. */
  id?: string;
  role: ChatMessageRole;
  kind: ChatMessageKind;
  content: string;
  transcriptSeq?: number | null;
  tokensIn?: number;
  tokensOut?: number;
  tokensCacheRead?: number;
  tokensCacheWrite?: number;
};

export class ChatMessageRepository extends BaseRepository<typeof chatMessages> {
  constructor(db: Executor) {
    super(db, chatMessages);
  }

  /**
   * Appends at the next seq of the chat. Idempotent on draft.id: a second call with the
   * same id returns the stored row and writes nothing. Writers to one chat queue on a
   * transaction-scoped advisory lock, so seq is allocated without collisions or retries;
   * inside a caller's transaction the lock is held until that transaction ends.
   */
  async append(chatId: string, draft: ChatMessageDraft): Promise<ChatMessage> {
    return (await this.appendOnce(chatId, draft)).message;
  }

  /** append() that also says whether this call wrote the row, so a caller can charge for it only once. */
  async appendOnce(chatId: string, draft: ChatMessageDraft): Promise<{ message: ChatMessage; created: boolean }> {
    if (draft.id) {
      const existing = await this.findInChat(chatId, draft.id);
      if (existing) return { message: existing, created: false };
    }
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`chat-messages:${chatId}`}, 0))`,
      );
      const rows = await tx
        .insert(chatMessages)
        .values({
          ...(draft.id ? { id: draft.id } : {}),
          chatId,
          seq: sql<number>`(SELECT COALESCE(MAX(${chatMessages.seq}), 0) + 1 FROM ${chatMessages} WHERE ${chatMessages.chatId} = ${chatId})`,
          role: draft.role,
          kind: draft.kind,
          content: draft.content,
          transcriptSeq: draft.transcriptSeq ?? null,
          tokensIn: draft.tokensIn ?? 0,
          tokensOut: draft.tokensOut ?? 0,
          tokensCacheRead: draft.tokensCacheRead ?? 0,
          tokensCacheWrite: draft.tokensCacheWrite ?? 0,
        })
        .onConflictDoNothing({ target: [chatMessages.id] })
        .returning();
      if (rows[0]) return { message: rows[0], created: true };
      const existing = draft.id ? await this.withExecutor(tx).findInChat(chatId, draft.id) : null;
      if (!existing) throw new Error(`append to chat ${chatId} returned no row`);
      return { message: existing, created: false };
    });
  }

  findInChat(chatId: string, id: string): Promise<ChatMessage | null> {
    return this.findOne(and(eq(chatMessages.chatId, chatId), eq(chatMessages.id, id))!);
  }

  listAfter(chatId: string, afterSeq: number, limit: number): Promise<ChatMessage[]> {
    return this.findMany({
      where: and(eq(chatMessages.chatId, chatId), gt(chatMessages.seq, afterSeq)),
      orderBy: asc(chatMessages.seq),
      limit,
    });
  }

  /** The newest summary message, or null if the chat was never compacted. */
  async latestSummary(chatId: string): Promise<ChatMessage | null> {
    const [row] = await this.findMany({
      where: and(eq(chatMessages.chatId, chatId), eq(chatMessages.role, "summary")),
      orderBy: desc(chatMessages.seq),
      limit: 1,
    });
    return row ?? null;
  }

  /** The last n messages in seq order, oldest first. */
  async tail(chatId: string, n: number): Promise<ChatMessage[]> {
    const rows = await this.findMany({
      where: eq(chatMessages.chatId, chatId),
      orderBy: desc(chatMessages.seq),
      limit: n,
    });
    return rows.reverse();
  }

  /** Chats whose newest message is a user message: nothing has answered it yet. */
  async chatsAwaitingReply(): Promise<string[]> {
    const rows = await this.db.execute<{ chat_id: string }>(sql`
      SELECT m.chat_id FROM chat_messages m
      WHERE m.role = 'user'
        AND m.seq = (SELECT MAX(seq) FROM chat_messages WHERE chat_id = m.chat_id)`);
    return Array.from(rows, (row) => row.chat_id);
  }

  async head(chatId: string): Promise<number> {
    const rows = await this.db
      .select({ head: max(chatMessages.seq) })
      .from(chatMessages)
      .where(eq(chatMessages.chatId, chatId));
    return rows[0]?.head ?? 0;
  }
}
