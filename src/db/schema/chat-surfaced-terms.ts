import { integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { chats } from "./chats";

/** Terms this chat has already pointed out. Kept per chat so chats never leak into each other. */
export const chatSurfacedTerms = pgTable(
  "chat_surfaced_terms",
  {
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    /** Normalized form used for dedup (lowercased, trimmed, whitespace collapsed). */
    termNorm: text("term_norm").notNull(),
    /** First spelling seen, for display. */
    term: text("term").notNull(),
    /** Transcript seq at which the term was first surfaced. */
    firstSeq: integer("first_seq").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.chatId, table.termNorm] })],
);

export type ChatSurfacedTerm = typeof chatSurfacedTerms.$inferSelect;
export type NewChatSurfacedTerm = typeof chatSurfacedTerms.$inferInsert;
