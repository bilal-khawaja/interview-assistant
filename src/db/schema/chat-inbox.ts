import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { chats } from "./chats";
import { oneOf } from "./helpers";

export const INBOX_MODES = ["steer", "followup"] as const;
export type InboxMode = (typeof INBOX_MODES)[number];

export const INBOX_STATES = ["admitted", "promoted"] as const;
export type InboxState = (typeof INBOX_STATES)[number];

/**
 * Two-phase input: a message is admitted (durably recorded, idempotent on messageId)
 * and later promoted into chat_messages. Rows left admitted after a crash are
 * promoted again on startup.
 */
export const chatInbox = pgTable(
  "chat_inbox",
  {
    messageId: uuid("message_id").primaryKey(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    mode: text("mode", { enum: INBOX_MODES }).notNull(),
    state: text("state", { enum: INBOX_STATES }).notNull().default("admitted"),
    text: text("text").notNull(),
    admittedAt: timestamp("admitted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
  },
  (table) => [
    check("chat_inbox_mode_check", oneOf(table.mode, INBOX_MODES)),
    check("chat_inbox_state_check", oneOf(table.state, INBOX_STATES)),
    index("chat_inbox_chat_state_idx").on(table.chatId, table.state, table.admittedAt),
  ],
);

export type ChatInboxItem = typeof chatInbox.$inferSelect;
export type NewChatInboxItem = typeof chatInbox.$inferInsert;
