import { check, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { oneOf } from "./helpers";

export const MEETING_STATUSES = ["created", "live", "ended"] as const;
export type MeetingStatus = (typeof MEETING_STATUSES)[number];

export const meetings = pgTable(
  "meetings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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
  ],
);

export type Meeting = typeof meetings.$inferSelect;
export type NewMeeting = typeof meetings.$inferInsert;
