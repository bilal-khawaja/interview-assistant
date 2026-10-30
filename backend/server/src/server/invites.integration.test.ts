import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { websocket } from "hono/bun";
import { fakeAuth, type FakeUser } from "../auth/testing";
import { createDb, type DbClient } from "../db/client";
import { InviteRepository, MemberRepository } from "../db/repositories/invite.repository";
import { ChatRepository, MeetingRepository } from "../db/repositories/meeting.repository";
import { MeetingParticipantRepository } from "../db/repositories/participant.repository";
import { SegmentRepository } from "../db/repositories/segment.repository";
import { meetingInvites, meetings as meetingsTable, transcriptSegments, user } from "../db/schema";
import { env } from "../env";
import { WakeHub } from "../log/wake";
import { createApp } from "./app";
import { CLOSE_ACCESS_REVOKED } from "./frames";
import { InviteService } from "./invite-service";
import { MeetingController } from "./meeting-controller";
import { RateLimiter } from "./rate-limit";

async function probe(): Promise<DbClient | null> {
  if (!env.DATABASE_URL) return null;
  try {
    const client = createDb(env.DATABASE_URL);
    await client.db.select().from(transcriptSegments).limit(0);
    await client.db.select().from(meetingInvites).limit(0);
    return client;
  } catch {
    return null;
  }
}

const client = await probe();
const run = client ? describe : describe.skip;

const tag = crypto.randomUUID().slice(0, 8);
const person = (name: string): FakeUser => ({
  id: `inv-${tag}-${name}`,
  email: `inv-${tag}-${name}@example.test`,
  name,
});
const alice = person("alice");
const bob = person("bob");
const carol = person("carol");
const dave = person("dave");
const eve = person("eve");
const everyone = [alice, bob, carol, dave, eve];

type Json = Record<string, any>;

run("meeting invites (postgres)", () => {
  const { db, sql } = client ?? ({} as DbClient);
  const meetings = new MeetingRepository(db);
  const members = new MemberRepository(db);
  const invites = new InviteRepository(db);
  const created: string[] = [];
  let server: ReturnType<typeof Bun.serve>;
  let http = "";
  let ws = "";

  const as = (who: FakeUser | null, extra: Record<string, string> = {}) => ({
    ...(who ? { authorization: `Bearer ${who.id}` } : {}),
    ...extra,
  });
  const call = (who: FakeUser | null, method: string, path: string, body?: unknown) =>
    fetch(`${http}${path}`, {
      method,
      headers: as(who, body === undefined ? {} : { "content-type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const json = async (res: Response): Promise<Json> => (await res.json()) as Json;
  const connect = (who: FakeUser, path: string) =>
    new Promise<WebSocket | null>((resolve) => {
      const socket = new WebSocket(`${ws}${path}`, { headers: as(who) } as never); // Bun accepts headers; the DOM type does not
      socket.onopen = () => resolve(socket);
      socket.onerror = () => resolve(null);
    });
  const closedWith = (socket: WebSocket, ms = 3_000) =>
    new Promise<number | null>((resolve) => {
      socket.onclose = (event) => resolve(event.code);
      setTimeout(() => resolve(null), ms);
    });

  /** A meeting that exists in the database, without a running producer. */
  const newMeeting = async (owner: FakeUser, title: string, status: "created" | "live" | "ended" = "live") => {
    const meeting = await meetings.create(title, owner.id);
    created.push(meeting.id);
    if (status !== "created") await meetings.setStatus(meeting.id, status);
    return meeting.id;
  };
  const makeLink = async (meetingId: string, body: Json = {}) => {
    const res = await call(alice, "POST", `/meetings/${meetingId}/invites`, body);
    expect(res.status).toBe(201);
    return json(res) as Promise<{ id: string; token: string; url: string }>;
  };
  const redeem = (who: FakeUser, token: string) => call(who, "POST", "/invites/redeem", { token });

  beforeAll(async () => {
    await db.insert(user).values(everyone.map((u) => ({ id: u.id, name: u.name, email: u.email })));
    const controller = new MeetingController({
      sql,
      meetings,
      segments: new SegmentRepository(db),
      chats: new ChatRepository(db),
      runner: { open: async () => undefined },
      host: { start: () => undefined },
      deepgramApiKey: "test-key",
      log: () => undefined,
    });
    const app = createApp({
      auth: fakeAuth(Object.fromEntries(everyone.map((u) => [u.id, u]))),
      meetings,
      segments: new SegmentRepository(db),
      participants: new MeetingParticipantRepository(db),
      hub: new WakeHub(),
      heartbeatMs: 1_000,
      maxBufferedBytes: 1_000_000,
      meetingApi: controller,
      invites: {
        service: new InviteService(db),
        invites,
        members,
        meetings,
        redeemLimiter: new RateLimiter(1_000, 60_000),
        sourceOf: (id) => controller.sourceOf(id),
        linkPrefix: "interview-assistant://join/",
      },
    });
    server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
    http = `http://localhost:${server.port}`;
    ws = `ws://localhost:${server.port}`;
  });

  afterAll(async () => {
    await server?.stop(true);
    if (created.length) await db.delete(meetingsTable).where(inArray(meetingsTable.id, created));
    await db.delete(user).where(inArray(user.id, everyone.map((u) => u.id)));
    await client?.close();
  });

  describe("making a link", () => {
    test("the owner gets a token and a link; only the hash is stored", async () => {
      const meetingId = await newMeeting(alice, "make");
      const link = await makeLink(meetingId, { expiresInMinutes: 60, maxUses: 3 });
      expect(link.url).toBe(`interview-assistant://join/${link.token}`);
      expect(link.token.length).toBeGreaterThanOrEqual(40);
      const [row] = await db.select().from(meetingInvites).where(eq(meetingInvites.id, link.id));
      expect(row?.tokenHash).not.toBe(link.token);
      expect(JSON.stringify(row)).not.toContain(link.token);
      expect(row?.maxUses).toBe(3);
    });

    test("listing links never shows the token", async () => {
      const meetingId = await newMeeting(alice, "list");
      const link = await makeLink(meetingId);
      const res = await call(alice, "GET", `/meetings/${meetingId}/invites`);
      const text = await res.text();
      expect(text).not.toContain(link.token);
      expect((JSON.parse(text) as Json).invites.map((i: Json) => i.id)).toEqual([link.id]);
    });

    test("anyone but the owner gets 404 for links and for removing people, strangers and members alike", async () => {
      const meetingId = await newMeeting(alice, "owner only");
      const link = await makeLink(meetingId);
      expect((await redeem(bob, link.token)).status).toBe(200);
      for (const who of [bob, eve]) {
        expect((await call(who, "POST", `/meetings/${meetingId}/invites`, {})).status).toBe(404);
        expect((await call(who, "GET", `/meetings/${meetingId}/invites`)).status).toBe(404);
        expect((await call(who, "DELETE", `/meetings/${meetingId}/invites/${link.id}`)).status).toBe(404);
        expect((await call(who, "DELETE", `/meetings/${meetingId}/members/${bob.id}`)).status).toBe(404);
      }
      expect((await call(null, "POST", `/meetings/${meetingId}/invites`, {})).status).toBe(401);
    });

    test("bad lifetimes and use limits are refused", async () => {
      const meetingId = await newMeeting(alice, "validate");
      for (const body of [{ expiresInMinutes: 1 }, { expiresInMinutes: 60 * 24 * 30 }, { maxUses: 0 }, { maxUses: 1.5 }]) {
        expect((await call(alice, "POST", `/meetings/${meetingId}/invites`, body)).status, JSON.stringify(body)).toBe(400);
      }
    });

    test("an ended meeting takes no new link", async () => {
      const meetingId = await newMeeting(alice, "ended", "ended");
      expect((await call(alice, "POST", `/meetings/${meetingId}/invites`, {})).status).toBe(409);
    });
  });

  describe("joining", () => {
    test("redeeming a link makes the caller a participant who can read but not run the meeting", async () => {
      const meetingId = await newMeeting(alice, "join");
      expect((await call(bob, "GET", `/meetings/${meetingId}`)).status).toBe(404);

      const link = await makeLink(meetingId);
      const res = await redeem(bob, link.token);
      expect(res.status).toBe(200);
      const joined = await json(res);
      expect(joined.id).toBe(meetingId);
      expect(joined.role).toBe("participant");

      const seen = await json(await call(bob, "GET", `/meetings/${meetingId}`));
      expect(seen.role).toBe("participant");
      const list = await json(await call(bob, "GET", "/meetings"));
      expect(list.meetings.find((m: Json) => m.id === meetingId)?.role).toBe("participant");
      const mine = await json(await call(alice, "GET", `/meetings/${meetingId}`));
      expect(mine.role).toBe("owner");

      const stream = await connect(bob, `/meetings/${meetingId}/stream`);
      expect(stream).not.toBeNull();
      stream?.close();

      expect((await call(bob, "POST", `/meetings/${meetingId}/end`)).status).toBe(404);
      expect(await connect(bob, `/meetings/${meetingId}/audio`)).toBeNull();
      expect((await call(bob, "GET", `/meetings/${meetingId}/chats`)).status).toBe(404);
      expect((await call(eve, "GET", `/meetings/${meetingId}`)).status).toBe(404);
    });

    test("the owner sees everyone in the meeting, themselves first, with email addresses", async () => {
      const meetingId = await newMeeting(alice, "members");
      const link = await makeLink(meetingId);
      await redeem(bob, link.token);
      await redeem(carol, link.token);
      const res = await json(await call(alice, "GET", `/meetings/${meetingId}/members`));
      expect(res.members.map((m: Json) => [m.userId, m.role])).toEqual([
        [alice.id, "owner"],
        [bob.id, "participant"],
        [carol.id, "participant"],
      ]);
      expect(res.members.every((m: Json) => typeof m.email === "string")).toBe(true);
    });

    test("a participant sees the same people, without their email addresses; a stranger sees nothing", async () => {
      const meetingId = await newMeeting(alice, "roster");
      const link = await makeLink(meetingId);
      await redeem(bob, link.token);
      await redeem(carol, link.token);

      const res = await call(bob, "GET", `/meetings/${meetingId}/members`);
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.members.map((m: Json) => [m.userId, m.role, m.name])).toEqual([
        [alice.id, "owner", alice.name],
        [bob.id, "participant", bob.name],
        [carol.id, "participant", carol.name],
      ]);
      expect(JSON.stringify(body)).not.toContain("example.test");
      expect(body.members.some((m: Json) => "email" in m)).toBe(false);

      expect((await call(eve, "GET", `/meetings/${meetingId}/members`)).status).toBe(404);
      expect((await call(null, "GET", `/meetings/${meetingId}/members`)).status).toBe(401);

      // Once someone leaves they are gone from everyone's list, and cannot read it any more.
      await call(carol, "POST", `/meetings/${meetingId}/leave`);
      const after = await json(await call(bob, "GET", `/meetings/${meetingId}/members`));
      expect(after.members.map((m: Json) => m.userId)).toEqual([alice.id, bob.id]);
      expect((await call(carol, "GET", `/meetings/${meetingId}/members`)).status).toBe(404);
    });

    test("redeeming twice is fine and costs one use; the owner redeeming costs none", async () => {
      const meetingId = await newMeeting(alice, "idempotent");
      const link = await makeLink(meetingId, { maxUses: 5 });
      expect((await redeem(bob, link.token)).status).toBe(200);
      expect((await redeem(bob, link.token)).status).toBe(200);
      const own = await redeem(alice, link.token);
      expect((await json(own)).role).toBe("owner");
      const [row] = await db.select().from(meetingInvites).where(eq(meetingInvites.id, link.id));
      expect(row?.useCount).toBe(1);
    });

    test("unknown, malformed, expired, revoked and used-up links all look the same", async () => {
      const meetingId = await newMeeting(alice, "failures");

      const expired = await makeLink(meetingId);
      await db.update(meetingInvites).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(meetingInvites.id, expired.id));

      const revoked = await makeLink(meetingId);
      expect((await call(alice, "DELETE", `/meetings/${meetingId}/invites/${revoked.id}`)).status).toBe(204);

      const single = await makeLink(meetingId, { maxUses: 1 });
      expect((await redeem(carol, single.token)).status).toBe(200);

      const bodies = new Set<string>();
      for (const token of ["x".repeat(43), expired.token, revoked.token, single.token]) {
        const res = await redeem(eve, token);
        expect(res.status, token).toBe(404);
        bodies.add(await res.text());
      }
      expect(bodies.size).toBe(1);
      expect((await redeem(eve, "short")).status).toBe(400);
      expect((await call(eve, "GET", `/meetings/${meetingId}`)).status).toBe(404);
      expect((await call(null, "POST", "/invites/redeem", { token: expired.token })).status).toBe(401);
    });

    test("a link with one use left lets exactly one of two simultaneous redeemers in", async () => {
      const meetingId = await newMeeting(alice, "race");
      const link = await makeLink(meetingId, { maxUses: 1 });
      const results = await Promise.all([redeem(bob, link.token), redeem(carol, link.token), redeem(dave, link.token)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 404, 404]);
      expect((await members.listActive(meetingId)).length).toBe(1);
      const [row] = await db.select().from(meetingInvites).where(eq(meetingInvites.id, link.id));
      expect(row?.useCount).toBe(1);
    });

    test("revoking a link stops new joins but keeps those already in", async () => {
      const meetingId = await newMeeting(alice, "revoke");
      const link = await makeLink(meetingId);
      await redeem(bob, link.token);
      expect((await call(alice, "DELETE", `/meetings/${meetingId}/invites/${link.id}`)).status).toBe(204);
      expect((await redeem(carol, link.token)).status).toBe(404);
      expect((await call(bob, "GET", `/meetings/${meetingId}`)).status).toBe(200);
      expect((await call(alice, "DELETE", `/meetings/${meetingId}/invites/${link.id}`)).status).toBe(404);
    });

    test("a link to a meeting that has ended no longer works, but members keep the history", async () => {
      const meetingId = await newMeeting(alice, "ends");
      const link = await makeLink(meetingId);
      await redeem(bob, link.token);
      await meetings.setStatus(meetingId, "ended");
      expect((await redeem(carol, link.token)).status).toBe(404);
      expect((await call(bob, "GET", `/meetings/${meetingId}`)).status).toBe(200);
    });
  });

  describe("leaving and being removed", () => {
    test("removing a member closes their open stream and locks them out", async () => {
      const meetingId = await newMeeting(alice, "remove");
      const link = await makeLink(meetingId);
      await redeem(bob, link.token);
      const stream = await connect(bob, `/meetings/${meetingId}/stream`);
      expect(stream).not.toBeNull();
      const closed = closedWith(stream!);

      expect((await call(alice, "DELETE", `/meetings/${meetingId}/members/${bob.id}`)).status).toBe(204);
      expect(await closed).toBe(CLOSE_ACCESS_REVOKED);
      expect((await call(bob, "GET", `/meetings/${meetingId}`)).status).toBe(404);
      expect(await connect(bob, `/meetings/${meetingId}/stream`)).toBeNull();
      expect((await call(alice, "DELETE", `/meetings/${meetingId}/members/${bob.id}`)).status).toBe(404);
    });

    test("a removed member cannot come back on the link they hold, only on a newer one", async () => {
      const meetingId = await newMeeting(alice, "ban");
      const old = await makeLink(meetingId);
      await redeem(bob, old.token);
      await call(alice, "DELETE", `/meetings/${meetingId}/members/${bob.id}`);
      expect((await redeem(bob, old.token)).status).toBe(404);

      await Bun.sleep(5);
      const fresh = await makeLink(meetingId);
      expect((await redeem(bob, fresh.token)).status).toBe(200);
      expect((await call(bob, "GET", `/meetings/${meetingId}`)).status).toBe(200);
    });

    test("leaving closes the member's stream and ends their access", async () => {
      const meetingId = await newMeeting(alice, "leave");
      const link = await makeLink(meetingId);
      await redeem(bob, link.token);
      const stream = await connect(bob, `/meetings/${meetingId}/stream`);
      const closed = closedWith(stream!);

      expect((await call(bob, "POST", `/meetings/${meetingId}/leave`)).status).toBe(204);
      expect(await closed).toBe(CLOSE_ACCESS_REVOKED);
      expect((await call(bob, "GET", `/meetings/${meetingId}`)).status).toBe(404);
      expect((await call(bob, "POST", `/meetings/${meetingId}/leave`)).status).toBe(404);
      // Not a member, and the owner cannot "leave" their own meeting.
      expect((await call(alice, "POST", `/meetings/${meetingId}/leave`)).status).toBe(404);
      expect((await call(alice, "GET", `/meetings/${meetingId}`)).status).toBe(200);
    });

    test("removing one member leaves another's stream open", async () => {
      const meetingId = await newMeeting(alice, "isolated");
      const link = await makeLink(meetingId);
      await redeem(bob, link.token);
      await redeem(carol, link.token);
      const carolStream = await connect(carol, `/meetings/${meetingId}/stream`);
      let carolClosed = false;
      carolStream!.onclose = () => (carolClosed = true);
      await call(alice, "DELETE", `/meetings/${meetingId}/members/${bob.id}`);
      await Bun.sleep(200);
      expect(carolClosed).toBe(false);
      carolStream!.close();
    });
  });
});
