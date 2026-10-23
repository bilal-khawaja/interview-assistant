import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { meetings } from "./meetings";

export const transcriptSegments = pgTable(
  "transcript_segments",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    speakerKey: text("speaker_key"),
    text: text("text").notNull(),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    source: text("source").notNull().default("stt"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("transcript_segments_meeting_seq").on(table.meetingId, table.seq),
    check("transcript_segments_seq_positive", sql`${table.seq} > 0`),
    check(
      "transcript_segments_time_order",
      sql`${table.endMs} >= ${table.startMs}`,
    ),
  ],
);

export type TranscriptSegment = typeof transcriptSegments.$inferSelect;
export type NewTranscriptSegment = typeof transcriptSegments.$inferInsert;
