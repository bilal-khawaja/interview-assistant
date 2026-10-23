import { sql } from "drizzle-orm";
import { bigint, check, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { chats } from "./chats";

export const chatBudget = pgTable(
  "chat_budget",
  {
    chatId: uuid("chat_id")
      .primaryKey()
      .references(() => chats.id, { onDelete: "cascade" }),
    tokenLimit: bigint("token_limit", { mode: "number" }).notNull(),
    tokensUsed: bigint("tokens_used", { mode: "number" }).notNull().default(0),
    /** Spend in millionths of a dollar, so it stays an exact integer. */
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("chat_budget_limit_positive", sql`${table.tokenLimit} > 0`),
    check("chat_budget_used_nonnegative", sql`${table.tokensUsed} >= 0`),
  ],
);

export type ChatBudget = typeof chatBudget.$inferSelect;
export type NewChatBudget = typeof chatBudget.$inferInsert;
