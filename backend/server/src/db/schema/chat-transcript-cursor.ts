import { integer, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { chats } from "./chats";

export const chatTranscriptCursor = pgTable("chat_transcript_cursor", {
  chatId: uuid("chat_id")
    .primaryKey()
    .references(() => chats.id, { onDelete: "cascade" }),
  lastSeenSeq: integer("last_seen_seq").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ChatTranscriptCursor = typeof chatTranscriptCursor.$inferSelect;
export type NewChatTranscriptCursor = typeof chatTranscriptCursor.$inferInsert;
