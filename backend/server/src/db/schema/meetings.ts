import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { oneOf } from "./helpers";

export const MEETING_STATUSES = ["created", "live", "ended"] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const meetings = pgTable(
  "meetings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The owner. Chats, segments and messages hang off the meeting, so this covers all of them. */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull().default(""),
    status: text("status", { enum: MEETING_STATUSES })
      .notNull()
      .default("created"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    producerHeartbeatAt: timestamp("producer_heartbeat_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("meetings_status_check", oneOf(table.status, MEETING_STATUSES)),
    index("meetings_user_id_created_at_idx").on(table.userId, table.createdAt),
  ],
);

export type Meeting = typeof meetings.$inferSelect;
export type NewMeeting = typeof meetings.$inferInsert;
