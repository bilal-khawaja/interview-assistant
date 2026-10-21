import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { oneOf } from "./helpers";
import { meetings } from "./meetings";
import { people } from "./people";

export const PARTICIPANT_ROLES = [
  "host",
  "interviewer",
  "candidate",
  "observer",
] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

export const meetingParticipants = pgTable(
  "meeting_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "restrict" }),
    role: text("role", { enum: PARTICIPANT_ROLES }).notNull(),
    label: text("label"),
    speakerKey: text("speaker_key"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("meeting_participants_person").on(table.meetingId, table.personId),
    unique("meeting_participants_speaker").on(table.meetingId, table.speakerKey),
    check("meeting_participants_role_check", oneOf(table.role, PARTICIPANT_ROLES)),
    index("meeting_participants_person_idx").on(table.personId),
  ],
);

export type MeetingParticipant = typeof meetingParticipants.$inferSelect;
export type NewMeetingParticipant = typeof meetingParticipants.$inferInsert;
