import { eq, sql } from "drizzle-orm";
import type { Executor } from "../client";
import { chatTranscriptCursor, type ChatTranscriptCursor } from "../schema";
import { MutableRepository } from "./base.repository";

export class CursorRepository extends MutableRepository<
  typeof chatTranscriptCursor
> {
  constructor(db: Executor) {
    super(db, chatTranscriptCursor);
  }

  get(chatId: string): Promise<ChatTranscriptCursor | null> {
    return this.findOne(eq(chatTranscriptCursor.chatId, chatId));
  }

  async ensure(chatId: string, initialSeq: number): Promise<ChatTranscriptCursor> {
    await this.insertIgnore(
      [{ chatId, lastSeenSeq: initialSeq }],
      [chatTranscriptCursor.chatId],
    );
    const row = await this.get(chatId);
    if (!row) throw new Error(`cursor for chat ${chatId} vanished after ensure`);
    return row;
  }

  advance(chatId: string, seq: number): Promise<ChatTranscriptCursor> {
    return this.upsert(
      { chatId, lastSeenSeq: seq },
      [chatTranscriptCursor.chatId],
      {
        lastSeenSeq: sql`GREATEST(${chatTranscriptCursor.lastSeenSeq}, EXCLUDED.last_seen_seq)`,
        updatedAt: sql`now()`,
      },
    );
  }
}
