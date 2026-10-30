import type { Hono } from "hono";
import { z } from "zod";
import { currentUserId } from "../auth/routes";
import type { InviteRepository, MemberRepository } from "../db/repositories/invite.repository";
import type { MeetingRepository } from "../db/repositories/meeting.repository";
import type { MeetingInvite } from "../db/schema";
import type { StreamVariables } from "./app";
import { CLOSE_ACCESS_REVOKED } from "./frames";
import {
  DEFAULT_INVITE_MINUTES,
  MAX_INVITE_MINUTES,
  MAX_INVITE_USES,
  MIN_INVITE_MINUTES,
  type InviteService,
} from "./invite-service";
import { meetingJson } from "./meeting-routes";
import type { RateLimiter } from "./rate-limit";
import type { SocketRegistry } from "./socket-registry";

export type InviteApiDeps = {
  service: Pick<InviteService, "create" | "redeem">;
  invites: Pick<InviteRepository, "listActive" | "revoke">;
  members: Pick<MemberRepository, "listActive" | "owner" | "remove" | "leave" | "find">;
  meetings: Pick<MeetingRepository, "findOwned" | "findAccessible">;
  sockets: SocketRegistry;
  /** Limits redeem attempts per account. */
  redeemLimiter: Pick<RateLimiter, "allow">;
  sourceOf(meetingId: string): string | null;
  /** A member is gone (removed or left): stop taking their audio. */
  onMemberGone?(meetingId: string, userId: string): void;
  /** What a token is appended to when the link is shown, e.g. interview-assistant://join/ */
  linkPrefix: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createBody = z.object({
  expiresInMinutes: z.number().int().min(MIN_INVITE_MINUTES).max(MAX_INVITE_MINUTES).default(DEFAULT_INVITE_MINUTES),
  maxUses: z.number().int().min(1).max(MAX_INVITE_USES).nullable().optional(),
});

const redeemBody = z.object({ token: z.string().trim().min(16).max(256) });

function inviteJson(invite: MeetingInvite) {
  return {
    id: invite.id,
    expiresAt: invite.expiresAt.toISOString(),
    maxUses: invite.maxUses,
    useCount: invite.useCount,
    createdAt: invite.createdAt.toISOString(),
  };
}

/** Mounts the invite links and member management of a meeting. Every route needs a signed-in user. */
export function mountInviteRoutes(
  app: Hono<{ Variables: StreamVariables & Record<string, unknown> }>,
  deps: InviteApiDeps,
): void {
  const owned = async (userId: string, id: string) => (UUID.test(id) ? deps.meetings.findOwned(id, userId) : null);

  app.post("/meetings/:id/invites", async (c) => {
    const body = createBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid body", issues: body.error.issues }, 400);
    const id = c.req.param("id");
    if (!UUID.test(id)) return c.json({ error: "not found" }, 404);
    const result = await deps.service.create(currentUserId(c), id, body.data);
    if (result === "not_found") return c.json({ error: "not found" }, 404);
    if (result === "ended") return c.json({ error: "meeting has ended" }, 409);
    return c.json({ ...inviteJson(result.invite), token: result.token, url: `${deps.linkPrefix}${result.token}` }, 201);
  });

  app.get("/meetings/:id/invites", async (c) => {
    const meeting = await owned(currentUserId(c), c.req.param("id"));
    if (!meeting) return c.json({ error: "not found" }, 404);
    return c.json({ invites: (await deps.invites.listActive(meeting.id)).map(inviteJson) });
  });

  app.delete("/meetings/:id/invites/:inviteId", async (c) => {
    const meeting = await owned(currentUserId(c), c.req.param("id"));
    const inviteId = c.req.param("inviteId");
    if (!meeting || !UUID.test(inviteId) || !(await deps.invites.revoke(meeting.id, inviteId))) {
      return c.json({ error: "not found" }, 404);
    }
    return c.body(null, 204);
  });

  // Everyone in a meeting can see who else is in it. Email addresses are the owner's to see:
  // they are how the owner tells two people with the same name apart.
  app.get("/meetings/:id/members", async (c) => {
    const userId = currentUserId(c);
    const id = c.req.param("id");
    const meeting = UUID.test(id) ? await deps.meetings.findAccessible(id, userId) : null;
    if (!meeting) return c.json({ error: "not found" }, 404);
    const asOwner = meeting.role === "owner";
    const [host, members] = await Promise.all([deps.members.owner(meeting.id), deps.members.listActive(meeting.id)]);
    const entry = (person: { userId: string; name: string; email: string }, role: string, joinedAt: Date) => ({
      userId: person.userId,
      name: person.name,
      ...(asOwner ? { email: person.email } : {}),
      role,
      joinedAt: joinedAt.toISOString(),
    });
    return c.json({
      members: [
        ...(host ? [entry(host, "owner", meeting.startedAt ?? meeting.createdAt)] : []),
        ...members.map((m) => entry(m, m.role, m.joinedAt)),
      ],
    });
  });

  app.delete("/meetings/:id/members/:userId", async (c) => {
    const meeting = await owned(currentUserId(c), c.req.param("id"));
    const target = c.req.param("userId");
    if (!meeting || !(await deps.members.remove(meeting.id, target))) return c.json({ error: "not found" }, 404);
    deps.onMemberGone?.(meeting.id, target);
    deps.sockets.closeUser(meeting.id, target, CLOSE_ACCESS_REVOKED, "removed from meeting");
    return c.body(null, 204);
  });

  app.post("/meetings/:id/leave", async (c) => {
    const id = c.req.param("id");
    const userId = currentUserId(c);
    if (!UUID.test(id) || !(await deps.members.leave(id, userId))) return c.json({ error: "not found" }, 404);
    deps.onMemberGone?.(id, userId);
    deps.sockets.closeUser(id, userId, CLOSE_ACCESS_REVOKED, "left meeting");
    return c.body(null, 204);
  });

  app.post("/invites/redeem", async (c) => {
    const userId = currentUserId(c);
    if (!deps.redeemLimiter.allow(userId)) return c.json({ error: "too many attempts" }, 429);
    const body = redeemBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body" }, 400);
    const meeting = await deps.service.redeem(userId, body.data.token);
    if (!meeting) return c.json({ error: "not found" }, 404);
    return c.json(meetingJson(meeting, deps.sourceOf(meeting.id)));
  });
}
