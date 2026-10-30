import { check, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { oneOf } from "./helpers";
import { meetingInvites } from "./meeting-invites";
import { meetings } from "./meetings";

export const MEMBER_ROLES = ["participant"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** Accounts other than the owner who joined a meeting through an invite link. */
export const meetingMembers = pgTable(
  "meeting_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role", { enum: MEMBER_ROLES }).notNull().default("participant"),
    viaInviteId: uuid("via_invite_id").references(() => meetingInvites.id, { onDelete: "set null" }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set when the owner removes the member or they leave; the row stays so the history is kept. */
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (table) => [
    unique("meeting_members_meeting_user").on(table.meetingId, table.userId),
    check("meeting_members_role_check", oneOf(table.role, MEMBER_ROLES)),
    index("meeting_members_user_idx").on(table.userId),
  ],
);

export type MeetingMember = typeof meetingMembers.$inferSelect;
export type NewMeetingMember = typeof meetingMembers.$inferInsert;
