import { and, asc, eq } from "drizzle-orm";
import type { Executor } from "../client";
import { chatInbox, type ChatInboxItem, type InboxMode } from "../schema";
import { MutableRepository } from "./base.repository";

export type AdmitResult = { item: ChatInboxItem; created: boolean };

export class InboxIdConflictError extends Error {
  constructor(readonly messageId: string) {
    super(`message ${messageId} was already admitted to a different chat`);
    this.name = "InboxIdConflictError";
  }
}

export class ChatInboxRepository extends MutableRepository<typeof chatInbox> {
  constructor(db: Executor) {
    super(db, chatInbox);
  }

  /** Records the input once. Re-admitting the same messageId returns the stored row with created=false. */
  async admit(
    chatId: string,
    messageId: string,
    mode: InboxMode,
    text: string,
  ): Promise<AdmitResult> {
    const inserted = await this.insertIgnore(
      [{ messageId, chatId, mode, text }],
      [chatInbox.messageId],
    );
    if (inserted[0]) return { item: inserted[0], created: true };
    const existing = await this.findOne(eq(chatInbox.messageId, messageId));
    if (!existing) throw new Error(`inbox row ${messageId} vanished after admit`);
    if (existing.chatId !== chatId) throw new InboxIdConflictError(messageId);
    return { item: existing, created: false };
  }

  /** Marks an admitted item promoted. Returns null if it was already promoted (or is unknown). */
  async promote(chatId: string, messageId: string): Promise<ChatInboxItem | null> {
    const rows = await this.updateWhere(
      and(
        eq(chatInbox.chatId, chatId),
        eq(chatInbox.messageId, messageId),
        eq(chatInbox.state, "admitted"),
      )!,
      { state: "promoted", promotedAt: new Date() },
    );
    return rows[0] ?? null;
  }

  /** Admitted but not yet promoted, oldest first. */
  pending(chatId: string, mode?: InboxMode): Promise<ChatInboxItem[]> {
    return this.findMany({
      where: and(
        eq(chatInbox.chatId, chatId),
        eq(chatInbox.state, "admitted"),
        ...(mode ? [eq(chatInbox.mode, mode)] : []),
      )!,
      orderBy: asc(chatInbox.admittedAt),
    });
  }

  /** Startup recovery: every chat's unpromoted items. */
  allPending(): Promise<ChatInboxItem[]> {
    return this.findMany({
      where: eq(chatInbox.state, "admitted"),
      orderBy: asc(chatInbox.admittedAt),
    });
  }
}
