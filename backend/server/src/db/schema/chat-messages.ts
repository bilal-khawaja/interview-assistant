import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { chats } from "./chats";
import { oneOf } from "./helpers";

export const CHAT_MESSAGE_ROLES = ["user", "assistant", "system", "summary"] as const;
export type ChatMessageRole = (typeof CHAT_MESSAGE_ROLES)[number];

// steer / followup: how a user message was admitted. suggestion: unprompted assistant
// output driven by the transcript. reply: assistant answer to a user message.
export const CHAT_MESSAGE_KINDS = [
  "steer",
  "followup",
  "suggestion",
  "reply",
  "notice",
  "summary",
] as const;
export type ChatMessageKind = (typeof CHAT_MESSAGE_KINDS)[number];

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    role: text("role", { enum: CHAT_MESSAGE_ROLES }).notNull(),
    kind: text("kind", { enum: CHAT_MESSAGE_KINDS }).notNull(),
    content: text("content").notNull(),
    /** Last transcript seq the model had seen when it produced this message. */
    transcriptSeq: integer("transcript_seq"),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    tokensCacheRead: integer("tokens_cache_read").notNull().default(0),
    tokensCacheWrite: integer("tokens_cache_write").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("chat_messages_chat_seq").on(table.chatId, table.seq),
    check("chat_messages_seq_positive", sql`${table.seq} > 0`),
    check("chat_messages_role_check", oneOf(table.role, CHAT_MESSAGE_ROLES)),
    check("chat_messages_kind_check", oneOf(table.kind, CHAT_MESSAGE_KINDS)),
    index("chat_messages_chat_created_idx").on(table.chatId, table.createdAt),
  ],
);

export type ChatMessage = typeof chatMessages.$inferSelect;
export type NewChatMessage = typeof chatMessages.$inferInsert;
