import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { chats } from "./chats";

/**
 * Per-chat prompt state. frozenPrompt is fixed for the whole epoch so the provider can
 * cache the prefix; a new epoch starts only on compaction or a meeting-level change.
 */
export const chatContext = pgTable("chat_context", {
  chatId: uuid("chat_id")
    .primaryKey()
    .references(() => chats.id, { onDelete: "cascade" }),
  epoch: integer("epoch").notNull().default(1),
  frozenPrompt: text("frozen_prompt").notNull().default(""),
  promptHash: text("prompt_hash").notNull().default(""),
  /** Messages with seq <= this are folded into the latest summary message. */
  summaryUptoSeq: integer("summary_upto_seq").notNull().default(0),
  topicState: jsonb("topic_state").$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type ChatContext = typeof chatContext.$inferSelect;
export type NewChatContext = typeof chatContext.$inferInsert;
