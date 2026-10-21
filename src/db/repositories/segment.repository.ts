import { and, asc, eq, gt, max } from "drizzle-orm";
import type { Executor } from "../client";
import {
  meetingParticipants,
  people,
  transcriptSegments,
  type MeetingParticipant,
  type NewTranscriptSegment,
  type Person,
  type TranscriptSegment,
} from "../schema";
import { BaseRepository } from "./base.repository";

export type ResolvedSegment = {
  segment: TranscriptSegment;
  participant: MeetingParticipant | null;
  person: Person | null;
};

export class SegmentRepository extends BaseRepository<
  typeof transcriptSegments
> {
  constructor(db: Executor) {
    super(db, transcriptSegments);
  }

  appendIgnore(rows: NewTranscriptSegment[]): Promise<TranscriptSegment[]> {
    return this.insertIgnore(rows, [
      transcriptSegments.meetingId,
      transcriptSegments.seq,
    ]);
  }

  readAfter(
    meetingId: string,
    afterSeq: number,
    limit: number,
  ): Promise<TranscriptSegment[]> {
    return this.findMany({
      where: and(
        eq(transcriptSegments.meetingId, meetingId),
        gt(transcriptSegments.seq, afterSeq),
      ),
      orderBy: asc(transcriptSegments.seq),
      limit,
    });
  }

  async readAfterResolved(
    meetingId: string,
    afterSeq: number,
    limit: number,
  ): Promise<ResolvedSegment[]> {
    const rows = await this.db
      .select({
        segment: transcriptSegments,
        participant: meetingParticipants,
        person: people,
      })
      .from(transcriptSegments)
      .leftJoin(
        meetingParticipants,
        and(
          eq(meetingParticipants.meetingId, transcriptSegments.meetingId),
          eq(meetingParticipants.speakerKey, transcriptSegments.speakerKey),
        ),
      )
      .leftJoin(people, eq(people.id, meetingParticipants.personId))
      .where(
        and(
          eq(transcriptSegments.meetingId, meetingId),
          gt(transcriptSegments.seq, afterSeq),
        ),
      )
      .orderBy(asc(transcriptSegments.seq))
      .limit(limit);
    return rows;
  }

  findBySeq(meetingId: string, seq: number): Promise<TranscriptSegment | null> {
    return this.findOne(
      and(
        eq(transcriptSegments.meetingId, meetingId),
        eq(transcriptSegments.seq, seq),
      )!,
    );
  }

  async head(meetingId: string): Promise<number> {
    const rows = await this.db
      .select({ head: max(transcriptSegments.seq) })
      .from(transcriptSegments)
      .where(eq(transcriptSegments.meetingId, meetingId));
    return rows[0]?.head ?? 0;
  }
}
