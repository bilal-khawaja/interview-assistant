import { createHash, randomBytes } from "node:crypto";
import type { Database } from "../db/client";
import { InviteRepository, MemberRepository } from "../db/repositories/invite.repository";
import { MeetingRepository, type AccessibleMeeting } from "../db/repositories/meeting.repository";
import type { MeetingInvite } from "../db/schema";

export const MIN_INVITE_MINUTES = 5;
export const MAX_INVITE_MINUTES = 7 * 24 * 60;
export const DEFAULT_INVITE_MINUTES = 24 * 60;
export const MAX_INVITE_USES = 100;

export type CreatedInvite = { invite: MeetingInvite; token: string };

/** The token is 256 bits of randomness, so a fast hash is enough: there is nothing to brute-force. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class InviteService {
  constructor(private readonly db: Database) {}

  /** A fresh link for a meeting the caller owns. The token is returned once and never stored. */
  async create(
    ownerId: string,
    meetingId: string,
    options: { expiresInMinutes: number; maxUses?: number | null },
  ): Promise<CreatedInvite | "not_found" | "ended"> {
    const meeting = await new MeetingRepository(this.db).findOwned(meetingId, ownerId);
    if (!meeting) return "not_found";
    if (meeting.status === "ended") return "ended";
    const token = randomBytes(32).toString("base64url");
    const invite = await new InviteRepository(this.db).create({
      meetingId,
      createdBy: ownerId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + options.expiresInMinutes * 60_000),
      maxUses: options.maxUses ?? null,
    });
    return { invite, token };
  }

  /**
   * Turns a link into membership for a signed-in user. Null for every way a link can fail
   * (unknown, expired, revoked, used up, meeting over, removed since), so a caller learns
   * nothing about which. The invite row is locked for the whole transaction, so concurrent
   * redeems of a limited link cannot both pass the use check.
   */
  redeem(userId: string, token: string, now: Date = new Date()): Promise<AccessibleMeeting | null> {
    return this.db.transaction(async (tx) => {
      const invites = new InviteRepository(tx);
      const members = new MemberRepository(tx);
      const meetings = new MeetingRepository(tx);

      const invite = await invites.lockByHash(hashToken(token));
      if (!invite) return null;
      const meeting = await meetings.findById(invite.meetingId);
      if (!meeting || meeting.status === "ended") return null;
      if (invite.revokedAt || invite.expiresAt <= now) return null;

      // The owner and people already in need nothing from the link, and it costs no use.
      if (meeting.userId === userId) return { ...meeting, role: "owner" };
      const existing = await members.find(meeting.id, userId);
      if (existing && !existing.removedAt) return { ...meeting, role: "participant" };

      // Someone the owner removed needs a link made after that, not the one they still hold.
      if (existing?.removedAt && invite.createdAt <= existing.removedAt) return null;
      if (invite.maxUses !== null && invite.useCount >= invite.maxUses) return null;

      await members.join(meeting.id, userId, invite.id);
      await invites.countUse(invite.id);
      return { ...meeting, role: "participant" };
    });
  }
}
