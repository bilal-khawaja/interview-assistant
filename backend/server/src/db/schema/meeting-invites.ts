import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { meetings } from "./meetings";

/** A link the owner hands out. Only the hash of its token is stored, so a leaked table joins nobody. */
export const meetingInvites = pgTable(
  "meeting_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Null means unlimited. */
    maxUses: integer("max_uses"),
    useCount: integer("use_count").notNull().default(0),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("meeting_invites_meeting_idx").on(table.meetingId)],
);

export type MeetingInvite = typeof meetingInvites.$inferSelect;
export type NewMeetingInvite = typeof meetingInvites.$inferInsert;
