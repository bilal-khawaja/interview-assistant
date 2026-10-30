import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
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
import { LiveAudioSource } from "../producer/live-audio";
import type { SourceSegment } from "../producer/source";
import { createApp } from "./app";
import { CLOSE_ACCESS_REVOKED } from "./frames";
import { InviteService } from "./invite-service";
import { MeetingController } from "./meeting-controller";
import { RateLimiter } from "./rate-limit";
import { SpeakerBinder } from "./speaker-binder";

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

/** A live source with no Deepgram: each chunk pushed becomes one segment, placed `baseMs` into the meeting. */
class EchoLiveSource extends LiveAudioSource {
  pushed = 0;
  constructor(private readonly offsetMs: number) {
    super({ baseMs: offsetMs, deepgram: { apiKey: "k" } });
  }
  override push(chunk: Uint8Array): boolean {
    const accepted = super.push(chunk);
    if (accepted) this.pushed++;
    return accepted;
  }
  override stream(signal: AbortSignal): AsyncIterable<SourceSegment> {
    const self = this;
    return (async function* () {
      let seen = 0;
      while (!signal.aborted) {
        if (self.pushed > seen) {
          yield { text: `audio ${seen}`, startMs: self.offsetMs + seen * 10, endMs: self.offsetMs + seen * 10 + 5 };
          seen++;
        } else if (self.isEnded) {
          return;
        } else {
          await Bun.sleep(10);
        }
      }
    })();
  }
}

const tag = crypto.randomUUID().slice(0, 8);
const person = (name: string): FakeUser => ({
  id: `mic-${tag}-${name}`,
  email: `mic-${tag}-${name}@example.test`,
  name: `${name} ${tag}`,
});
const alice = person("alice");
const bob = person("bob");
const carol = person("carol");
const dave = person("dave");
const everyone = [alice, bob, carol, dave];

run("several microphones in one meeting (postgres)", () => {
  const { db, sql } = client ?? ({} as DbClient);
  const meetings = new MeetingRepository(db);
  const segments = new SegmentRepository(db);
  const created: string[] = [];
  let controller: MeetingController;
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
  const json = async (res: Response) => (await res.json()) as Record<string, any>;
  const connect = (who: FakeUser, path: string) =>
    new Promise<WebSocket | null>((resolve) => {
      const socket = new WebSocket(`${ws}${path}`, { headers: as(who) } as never); // Bun accepts headers; the DOM type does not
      socket.onopen = () => resolve(socket);
      socket.onerror = () => resolve(null);
    });
  const sendChunks = async (socket: WebSocket, chunks: number) => {
    for (let i = 0; i < chunks; i++) socket.send(new Uint8Array(3200));
    await Bun.sleep(50);
  };
  const until = async (check: () => Promise<boolean>, ms = 5_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await Bun.sleep(25);
    }
    throw new Error("condition not met in time");
  };
  const startLive = async (who: FakeUser, title: string) => {
    const res = await call(who, "POST", "/meetings", { source: "live", title });
    const body = await json(res);
    if (body.id) created.push(body.id);
    else if (res.status !== 409) throw new Error(`could not start a meeting: ${res.status}`);
    return { status: res.status, id: body.id as string, body };
  };
  const join = async (owner: FakeUser, meetingId: string, ...guests: FakeUser[]) => {
    const link = await json(await call(owner, "POST", `/meetings/${meetingId}/invites`, {}));
    for (const guest of guests) {
      const res = await call(guest, "POST", "/invites/redeem", { token: link.token });
      expect(res.status).toBe(200);
    }
  };
  const rows = async (meetingId: string) =>
    (await segments.readAfter(meetingId, 0, 100)).map((s) => ({ text: s.text, key: s.speakerKey, startMs: s.startMs }));

  const build = (maxLiveSpeakers?: number) => {
    controller = new MeetingController({
      sql,
      meetings,
      segments,
      chats: new ChatRepository(db),
      runner: { open: async () => undefined },
      host: { start: () => undefined },
      deepgramApiKey: "test-key",
      speakers: new SpeakerBinder(db),
      endTimeoutMs: 5_000,
      appender: { retryBaseMs: 5, lockCheckMs: 0 },
      log: () => undefined,
      maxLiveSpeakers,
      createLiveSource: (_deepgram, _idle, baseMs) => new EchoLiveSource(baseMs),
    });
    const app = createApp({
      auth: fakeAuth(Object.fromEntries(everyone.map((u) => [u.id, u]))),
      meetings,
      segments,
      participants: new MeetingParticipantRepository(db),
      hub: new WakeHub(),
      heartbeatMs: 1_000,
      maxBufferedBytes: 1_000_000,
      pollMs: 20,
      meetingApi: controller,
      invites: {
        service: new InviteService(db),
        invites: new InviteRepository(db),
        members: new MemberRepository(db),
        meetings,
        redeemLimiter: new RateLimiter(1_000, 60_000),
        sourceOf: (id) => controller.sourceOf(id),
        onMemberGone: (meetingId, userId) => controller.dropParticipant(meetingId, userId),
        linkPrefix: "interview-assistant://join/",
      },
    });
    server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
    http = `http://localhost:${server.port}`;
    ws = `ws://localhost:${server.port}`;
  };

  beforeAll(async () => {
    await db.insert(user).values(everyone.map((u) => ({ id: u.id, name: u.name, email: u.email })));
    build(3);
  });

  // Each person can host one meeting at a time, so every test starts from none running.
  afterEach(async () => {
    await controller.shutdown();
  });

  afterAll(async () => {
    await controller?.shutdown();
    await server?.stop(true);
    if (created.length) await db.delete(meetingsTable).where(inArray(meetingsTable.id, created));
    await db.delete(user).where(inArray(user.id, everyone.map((u) => u.id)));
    await client?.close();
  });

  test("each person's audio lands in one transcript, tagged with who spoke and when they joined", async () => {
    const meeting = await startLive(alice, "two mics");
    expect(meeting.status).toBe(201);
    await join(alice, meeting.id, bob);

    const aliceMic = await connect(alice, `/meetings/${meeting.id}/audio`);
    await Bun.sleep(150);
    const bobMic = await connect(bob, `/meetings/${meeting.id}/audio`);
    expect(aliceMic).not.toBeNull();
    expect(bobMic).not.toBeNull();
    await sendChunks(aliceMic!, 2);
    await sendChunks(bobMic!, 3);
    await until(async () => (await rows(meeting.id)).length === 5);

    const all = await rows(meeting.id);
    const aliceKey = `user:${alice.id}`;
    const bobKey = `user:${bob.id}`;
    expect(all.filter((r) => r.key === aliceKey).length).toBe(2);
    expect(all.filter((r) => r.key === bobKey).length).toBe(3);
    // Bob joined after the meeting began, so his audio sits later on the shared timeline.
    expect(Math.min(...all.filter((r) => r.key === bobKey).map((r) => r.startMs))).toBeGreaterThanOrEqual(150);
    expect(Math.max(...all.filter((r) => r.key === aliceKey).map((r) => r.startMs))).toBeLessThan(100);

    aliceMic!.close();
    bobMic!.close();
  });

  test("the stream names each speaker from their account", async () => {
    const meeting = await startLive(carol, "names");
    await join(carol, meeting.id, dave);
    const carolMic = await connect(carol, `/meetings/${meeting.id}/audio`);
    const daveMic = await connect(dave, `/meetings/${meeting.id}/audio`);
    await sendChunks(carolMic!, 1);
    await sendChunks(daveMic!, 1);
    await until(async () => (await rows(meeting.id)).length === 2);
    await until(async () => (await new MeetingParticipantRepository(db).listForMeeting(meeting.id)).length === 2);

    const stream = await connect(dave, `/meetings/${meeting.id}/stream`);
    const frames: Record<string, any>[] = [];
    stream!.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
    await until(async () => frames.filter((f) => f.type === "segment").length === 2);

    const names = Object.fromEntries(
      frames.filter((f) => f.type === "segment").map((f) => [f.speakerKey, [f.speaker?.person.fullName, f.speaker?.role]]),
    );
    expect(names[`user:${carol.id}`]).toEqual([carol.name, "host"]);
    expect(names[`user:${dave.id}`]).toEqual([dave.name, "participant"]);
    stream!.close();
    carolMic!.close();
    daveMic!.close();
    await call(carol, "POST", `/meetings/${meeting.id}/end`);
  });

  test("a stranger, or a member of a meeting that is not live, cannot open audio", async () => {
    const meeting = await startLive(alice, "closed door");
    expect(await connect(carol, `/meetings/${meeting.id}/audio`)).toBeNull();
    expect((await call(carol, "GET", `/meetings/${meeting.id}/audio`)).status).toBe(404);

    const idle = await meetings.create("not running", alice.id);
    created.push(idle.id);
    await meetings.setStatus(idle.id, "live");
    await join(alice, idle.id, bob);
    expect((await call(bob, "GET", `/meetings/${idle.id}/audio`)).status).toBe(409);
    await call(alice, "POST", `/meetings/${meeting.id}/end`);
  });

  test("one microphone per person across meetings, both ways round", async () => {
    const aliceMeeting = await startLive(alice, "alice");
    const daveMeeting = await startLive(dave, "dave");
    await join(alice, aliceMeeting.id, bob, carol);
    await join(dave, daveMeeting.id, carol);

    const first = await connect(carol, `/meetings/${aliceMeeting.id}/audio`);
    expect(first).not.toBeNull();
    // Carol's microphone is open in alice's meeting, so dave's refuses it.
    expect((await call(carol, "GET", `/meetings/${daveMeeting.id}/audio`)).status).toBe(409);
    // And someone speaking in another person's meeting cannot start their own.
    const started = await startLive(carol, "carol");
    expect(started.status).toBe(409);
    expect(started.body.meetingId).toBe(aliceMeeting.id);

    // Dave is already hosting, so he cannot speak in alice's either.
    await join(alice, aliceMeeting.id, dave);
    expect((await call(dave, "GET", `/meetings/${aliceMeeting.id}/audio`)).status).toBe(409);

    first!.close();
    await call(alice, "POST", `/meetings/${aliceMeeting.id}/end`);
    await call(dave, "POST", `/meetings/${daveMeeting.id}/end`);
  });

  test("a meeting takes only so many microphones", async () => {
    const meeting = await startLive(alice, "crowd");
    await join(alice, meeting.id, bob, carol, dave);
    const one = await connect(bob, `/meetings/${meeting.id}/audio`);
    const two = await connect(carol, `/meetings/${meeting.id}/audio`);
    expect(one).not.toBeNull();
    expect(two).not.toBeNull();
    // Limit is 3 including alice's own.
    expect((await call(dave, "GET", `/meetings/${meeting.id}/audio`)).status).toBe(409);
    // Someone already speaking can reconnect.
    one!.close();
    expect(await connect(bob, `/meetings/${meeting.id}/audio`)).not.toBeNull();
    two!.close();
    await call(alice, "POST", `/meetings/${meeting.id}/end`);
  });

  test("removing a member stops their microphone and closes it, and the meeting carries on", async () => {
    const meeting = await startLive(alice, "kick");
    await join(alice, meeting.id, bob);
    const aliceMic = await connect(alice, `/meetings/${meeting.id}/audio`);
    const bobMic = await connect(bob, `/meetings/${meeting.id}/audio`);
    const closed = new Promise<number>((resolve) => (bobMic!.onclose = (event) => resolve(event.code)));
    await sendChunks(bobMic!, 1);
    await until(async () => (await rows(meeting.id)).length === 1);

    expect((await call(alice, "DELETE", `/meetings/${meeting.id}/members/${bob.id}`)).status).toBe(204);
    expect(await closed).toBe(CLOSE_ACCESS_REVOKED);
    expect((await call(bob, "GET", `/meetings/${meeting.id}/audio`)).status).toBe(404);

    await sendChunks(aliceMic!, 1);
    await until(async () => (await rows(meeting.id)).length === 2);
    expect(controller.sourceOf(meeting.id)).toBe("live");
    aliceMic!.close();
    await call(alice, "POST", `/meetings/${meeting.id}/end`);
  });

  test("a member leaving does not end the meeting, and ending it closes their audio", async () => {
    const meeting = await startLive(alice, "leave");
    await join(alice, meeting.id, bob, carol);
    const bobMic = await connect(bob, `/meetings/${meeting.id}/audio`);
    const carolMic = await connect(carol, `/meetings/${meeting.id}/audio`);

    expect((await call(bob, "POST", `/meetings/${meeting.id}/leave`)).status).toBe(204);
    expect(controller.sourceOf(meeting.id)).toBe("live");
    expect(controller.activeMeetingId(alice.id)).toBe(meeting.id);

    const carolClosed = new Promise<number>((resolve) => (carolMic!.onclose = (event) => resolve(event.code)));
    expect((await call(alice, "POST", `/meetings/${meeting.id}/end`)).status).toBe(200);
    // Carol's next chunk finds her input ended and the socket is closed.
    carolMic!.send(new Uint8Array(3200));
    expect(await carolClosed).toBe(1000);
    void bobMic;
  });

  test("the owner's own audio is unchanged for a meeting with nobody else", async () => {
    const meeting = await startLive(dave, "solo");
    const mic = await connect(dave, `/meetings/${meeting.id}/audio`);
    await sendChunks(mic!, 2);
    await until(async () => (await rows(meeting.id)).length === 2);
    expect((await rows(meeting.id)).map((r) => r.key)).toEqual([`user:${dave.id}`, `user:${dave.id}`]);
    const [member] = await db.select().from(meetingInvites).where(eq(meetingInvites.meetingId, meeting.id));
    expect(member).toBeUndefined();
    mic!.close();
    await call(dave, "POST", `/meetings/${meeting.id}/end`);
  });
});
