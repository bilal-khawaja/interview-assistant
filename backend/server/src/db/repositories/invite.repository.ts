import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Executor } from "../client";
import {
  meetingInvites,
  meetingMembers,
  meetings,
  user,
  type MeetingInvite,
  type MeetingMember,
  type NewMeetingInvite,
} from "../schema";
import { BaseRepository, MutableRepository } from "./base.repository";

export class InviteRepository extends MutableRepository<typeof meetingInvites> {
  constructor(db: Executor) {
    super(db, meetingInvites);
  }

  create(input: Pick<NewMeetingInvite, "meetingId" | "createdBy" | "tokenHash" | "expiresAt" | "maxUses">): Promise<MeetingInvite> {
    return this.insertOne(input);
  }

  /** Locks the row until the transaction ends, so concurrent redeems cannot overshoot `maxUses`. */
  async lockByHash(tokenHash: string): Promise<MeetingInvite | null> {
    const rows = await this.db
      .select()
      .from(meetingInvites)
      .where(eq(meetingInvites.tokenHash, tokenHash))
      .limit(1)
      .for("update");
    return rows[0] ?? null;
  }

  async countUse(id: string): Promise<void> {
    await this.updateWhere(eq(meetingInvites.id, id), { useCount: sql`${meetingInvites.useCount} + 1` as never });
  }

  /** Links that still work: not revoked, not expired. Newest first. */
  listActive(meetingId: string, now: Date = new Date()): Promise<MeetingInvite[]> {
    return this.findMany({
      where: and(
        eq(meetingInvites.meetingId, meetingId),
        isNull(meetingInvites.revokedAt),
        gt(meetingInvites.expiresAt, now),
      )!,
      orderBy: desc(meetingInvites.createdAt),
    });
  }

  /** True when a live link of this meeting was revoked by this call. */
  async revoke(meetingId: string, inviteId: string): Promise<boolean> {
    const rows = await this.updateWhere(
      and(eq(meetingInvites.id, inviteId), eq(meetingInvites.meetingId, meetingId), isNull(meetingInvites.revokedAt))!,
      { revokedAt: new Date() },
    );
    return rows.length > 0;
  }
}

export type MemberWithUser = MeetingMember & { name: string; email: string };

export class MemberRepository extends BaseRepository<typeof meetingMembers> {
  constructor(db: Executor) {
    super(db, meetingMembers);
  }

  find(meetingId: string, userId: string): Promise<MeetingMember | null> {
    return this.findOne(and(eq(meetingMembers.meetingId, meetingId), eq(meetingMembers.userId, userId))!);
  }

  /** Adds the member, or brings back one who left or was removed. */
  async join(meetingId: string, userId: string, viaInviteId: string): Promise<MeetingMember> {
    const rows = await this.db
      .insert(meetingMembers)
      .values({ meetingId, userId, viaInviteId })
      .onConflictDoUpdate({
        target: [meetingMembers.meetingId, meetingMembers.userId],
        set: { removedAt: null, viaInviteId, joinedAt: new Date() },
      })
      .returning();
    return rows[0]!;
  }

  /** The account that owns the meeting. */
  async owner(meetingId: string): Promise<{ userId: string; name: string; email: string } | null> {
    const rows = await this.db
      .select({ userId: user.id, name: user.name, email: user.email })
      .from(meetings)
      .innerJoin(user, eq(user.id, meetings.userId))
      .where(eq(meetings.id, meetingId))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Active members, oldest first. */
  async listActive(meetingId: string): Promise<MemberWithUser[]> {
    const rows = await this.db
      .select({ member: meetingMembers, name: user.name, email: user.email })
      .from(meetingMembers)
      .innerJoin(user, eq(user.id, meetingMembers.userId))
      .where(and(eq(meetingMembers.meetingId, meetingId), isNull(meetingMembers.removedAt)))
      .orderBy(meetingMembers.joinedAt);
    return rows.map((row) => ({ ...row.member, name: row.name, email: row.email }));
  }

  /** Marks the member removed (the owner's doing), so only a link made after this can bring them back. */
  async remove(meetingId: string, userId: string): Promise<boolean> {
    const rows = await this.db
      .update(meetingMembers)
      .set({ removedAt: new Date() })
      .where(
        and(
          eq(meetingMembers.meetingId, meetingId),
          eq(meetingMembers.userId, userId),
          isNull(meetingMembers.removedAt),
        ),
      )
      .returning();
    return rows.length > 0;
  }

  /** The member leaves on their own; the row goes, so the same link works again if it is still valid. */
  async leave(meetingId: string, userId: string): Promise<boolean> {
    const rows = await this.db
      .delete(meetingMembers)
      .where(
        and(
          eq(meetingMembers.meetingId, meetingId),
          eq(meetingMembers.userId, userId),
          isNull(meetingMembers.removedAt),
        ),
      )
      .returning();
    return rows.length > 0;
  }
}
