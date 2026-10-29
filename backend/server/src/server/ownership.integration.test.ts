import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { websocket } from "hono/bun";
import { fakeAuth, type FakeUser } from "../auth/testing";
import { KeyedCoordinator } from "../chat/keyed-coordinator";
import { ChatRunner } from "../chat/runner";
import { StubChatAgent } from "../chat/stub-agent";
import { createDb, type DbClient } from "../db/client";
import { ChatMessageRepository } from "../db/repositories/chat-message.repository";
import { ChatRepository, MeetingRepository } from "../db/repositories/meeting.repository";
import { MeetingParticipantRepository } from "../db/repositories/participant.repository";
import { SegmentRepository } from "../db/repositories/segment.repository";
import { meetings as meetingsTable, transcriptSegments, user } from "../db/schema";
import { env } from "../env";
import { PgWakeBridge, WakeHub } from "../log/wake";
import { LiveAudioSource } from "../producer/live-audio";
import type { SourceSegment } from "../producer/source";
import { createApp } from "./app";
import { MeetingController } from "./meeting-controller";

async function probe(): Promise<DbClient | null> {
  if (!env.DATABASE_URL) return null;
  try {
    const client = createDb(env.DATABASE_URL);
    await client.db.select().from(transcriptSegments).limit(0);
    return client;
  } catch {
    return null;
  }
}

const client = await probe();
const run = client ? describe : describe.skip;

/** A live source with no Deepgram: each audio chunk pushed in becomes one segment, and silence keeps it live. */
class EchoLiveSource extends LiveAudioSource {
  pushed = 0;
  constructor() {
    super({ baseMs: 0, deepgram: { apiKey: "k" } });
  }
  override push(chunk: Uint8Array): boolean {
    this.pushed++;
    return super.push(chunk);
  }
  override stream(signal: AbortSignal): AsyncIterable<SourceSegment> {
    const self = this;
    return (async function* () {
      let seen = 0;
      while (!signal.aborted && !self.isEnded) {
        if (self.pushed > seen) {
          yield { text: `audio ${seen}`, startMs: seen * 1000, endMs: seen * 1000 + 900 };
          seen++;
        } else {
          await Bun.sleep(10);
        }
      }
    })();
  }
}

const NIL = "00000000-0000-4000-8000-000000000000";
const tag = crypto.randomUUID().slice(0, 8);
const person = (name: string): FakeUser => ({
  id: `own-${tag}-${name}`,
  email: `own-${tag}-${name}@example.test`,
  name,
});
const alice = person("alice");
const bob = person("bob");
const carol = person("carol");
const dave = person("dave");

run("ownership (postgres)", () => {
  const { db, sql } = client ?? ({} as DbClient);
  const meetings = new MeetingRepository(db);
  const chats = new ChatRepository(db);
  const segments = new SegmentRepository(db);
  const chatHub = new WakeHub();
  const bridge = new PgWakeBridge(sql, chatHub, "chat_messages");
  const created: string[] = [];
  let controller: MeetingController;
  let server: ReturnType<typeof Bun.serve>;
  let http = "";
  let ws = "";
  let aliceMeeting = "";
  let aliceChat = "";
  let bobMeeting = "";

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
  const opens = (who: FakeUser | null, path: string) =>
    new Promise<boolean>((resolve) => {
      const socket = new WebSocket(`${ws}${path}`, { headers: as(who) } as never); // Bun accepts headers; the DOM type does not
      socket.onopen = () => {
        socket.close();
        resolve(true);
      };
      socket.onerror = () => resolve(false);
      socket.onclose = () => resolve(false);
    });

  beforeAll(async () => {
    await db.insert(user).values([alice, bob, carol, dave].map((u) => ({ id: u.id, name: u.name, email: u.email })));
    await bridge.start();
    const runner = new ChatRunner({
      db,
      coordinator: new KeyedCoordinator(),
      agent: new StubChatAgent(),
      onError: () => undefined,
    });
    controller = new MeetingController({
      sql,
      meetings,
      segments: new SegmentRepository(db),
      chats,
      runner: { open: async () => undefined },
      host: { start: () => undefined },
      deepgramApiKey: "test-key",
      endTimeoutMs: 5_000,
      appender: { retryBaseMs: 5, lockCheckMs: 0 },
      log: () => undefined,
      createLiveSource: () => new EchoLiveSource(),
    });
    const app = createApp({
      auth: fakeAuth({ [alice.id]: alice, [bob.id]: bob, [carol.id]: carol, [dave.id]: dave }),
      meetings,
      segments: new SegmentRepository(db),
      participants: new MeetingParticipantRepository(db),
      hub: new WakeHub(),
      heartbeatMs: 1_000,
      maxBufferedBytes: 1_000_000,
      meetingApi: controller,
      chat: {
        runner,
        host: { start: () => undefined },
        chats,
        messages: new ChatMessageRepository(db),
        hub: chatHub,
        heartbeatMs: 1_000,
        maxBufferedBytes: 1_000_000,
        pollMs: 5_000,
      },
    });
    server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
    http = `http://localhost:${server.port}`;
    ws = `ws://localhost:${server.port}`;

    const started = await call(alice, "POST", "/meetings", { source: "live", title: "alice meeting" });
    expect(started.status).toBe(201);
    aliceMeeting = ((await started.json()) as { id: string }).id;
    created.push(aliceMeeting);
    const chat = await call(alice, "POST", `/meetings/${aliceMeeting}/chats`, { title: "private" });
    aliceChat = ((await chat.json()) as { id: string }).id;
    bobMeeting = (await meetings.create("bob meeting", bob.id)).id;
    created.push(bobMeeting);
  });

  afterAll(async () => {
    await controller?.shutdown();
    await server?.stop(true);
    await bridge.stop();
    if (created.length) await db.delete(meetingsTable).where(inArray(meetingsTable.id, created));
    await db.delete(user).where(inArray(user.id, [alice.id, bob.id, carol.id, dave.id]));
    await client?.close();
  });

  const routes = (): [string, string, unknown?][] => [
    ["GET", "/meetings"],
    ["GET", `/meetings/${aliceMeeting}`],
    ["POST", `/meetings/${aliceMeeting}/end`],
    ["GET", `/meetings/${aliceMeeting}/stream`],
    ["GET", `/meetings/${aliceMeeting}/audio`],
    ["POST", "/meetings", { source: "live" }],
    ["POST", `/meetings/${aliceMeeting}/chats`, { title: "x" }],
    ["GET", `/meetings/${aliceMeeting}/chats`],
    ["POST", `/meetings/${aliceMeeting}/chats/${aliceChat}/messages`, { text: "hi" }],
    ["GET", `/meetings/${aliceMeeting}/chats/${aliceChat}/messages`],
    ["GET", `/meetings/${aliceMeeting}/chats/${aliceChat}/stream`],
  ];

  test("no token: every route is 401, and healthz stays open", async () => {
    for (const [method, path, body] of routes()) {
      expect((await call(null, method, path, body)).status, `${method} ${path}`).toBe(401);
    }
    expect((await call(null, "GET", "/healthz")).status).toBe(200);
  });

  test("an unknown token is 401 too", async () => {
    const res = await fetch(`${http}/meetings`, { headers: { authorization: "Bearer nope" } });
    expect(res.status).toBe(401);
  });

  test("another account gets 404 on every route that names alice's ids", async () => {
    for (const [method, path, body] of routes().filter(([, p]) => p.includes(aliceMeeting))) {
      expect((await call(bob, method, path, body)).status, `${method} ${path}`).toBe(404);
    }
  });

  test("a missing id and someone else's id look the same", async () => {
    const theirs = await call(bob, "GET", `/meetings/${aliceMeeting}`);
    const missing = await call(bob, "GET", `/meetings/${NIL}`);
    expect(theirs.status).toBe(missing.status);
    expect(await theirs.text()).toBe(await missing.text());
  });

  test("websockets are refused at the upgrade without the owner's token", async () => {
    const paths = [
      `/meetings/${aliceMeeting}/stream`,
      `/meetings/${aliceMeeting}/audio`,
      `/meetings/${aliceMeeting}/chats/${aliceChat}/stream`,
    ];
    for (const path of paths) {
      expect(await opens(null, path), `anonymous ${path}`).toBe(false);
      expect(await opens(bob, path), `bob ${path}`).toBe(false);
      expect(await opens(alice, path), `alice ${path}`).toBe(true);
    }
  });

  test("lists show only the caller's own meetings", async () => {
    const mine = (await (await call(alice, "GET", "/meetings")).json()) as { meetings: { id: string }[] };
    const his = (await (await call(bob, "GET", "/meetings")).json()) as { meetings: { id: string }[] };
    expect(mine.meetings.map((m) => m.id)).toEqual([aliceMeeting]);
    expect(his.meetings.map((m) => m.id)).toEqual([bobMeeting]);
  });

  test("bob's attempts leave alice's meeting live and untouched", async () => {
    await call(bob, "POST", `/meetings/${aliceMeeting}/end`);
    const after = (await (await call(alice, "GET", `/meetings/${aliceMeeting}`)).json()) as { status: string };
    expect(after.status).toBe("live");
  });

  test("a message id guessed from alice's chat cannot reach it from bob's side", async () => {
    const sent = await call(alice, "POST", `/meetings/${aliceMeeting}/chats/${aliceChat}/messages`, {
      messageId: crypto.randomUUID(),
      text: "secret",
    });
    expect(sent.status).toBe(202);
    const { messageId } = (await sent.json()) as { messageId: string };
    const bobChat = (await (await call(bob, "POST", `/meetings/${bobMeeting}/chats`, { title: "bob" })).json()) as {
      id: string;
    };
    // Message ids are global, so reusing alice's id is refused; nothing of hers is shown or changed.
    const own = await call(bob, "POST", `/meetings/${bobMeeting}/chats/${bobChat.id}/messages`, { messageId, text: "mine" });
    expect(own.status).toBe(409);
    expect(await own.json()).toEqual({ error: "messageId already used" });
    // Bob cannot post into alice's chat, nor reach either chat through the wrong meeting id.
    const attempts = [
      `/meetings/${aliceMeeting}/chats/${aliceChat}/messages`,
      `/meetings/${aliceMeeting}/chats/${bobChat.id}/messages`,
      `/meetings/${bobMeeting}/chats/${aliceChat}/messages`,
    ];
    for (const path of attempts) {
      expect((await call(bob, "POST", path, { messageId, text: "x" })).status, path).toBe(404);
    }
    const read = (await (
      await call(alice, "GET", `/meetings/${aliceMeeting}/chats/${aliceChat}/messages`)
    ).json()) as { messages: { content: string }[] };
    expect(read.messages.some((m) => m.content === "mine" || m.content === "x")).toBe(false);
  });

  describe("one live meeting per user", () => {
    const startLive = async (who: FakeUser, title: string) => {
      const res = await call(who, "POST", "/meetings", { source: "live", title });
      const json = (await res.json()) as { id?: string; meetingId?: string };
      if (json.id) created.push(json.id);
      return { status: res.status, json };
    };
    const sendAudio = (who: FakeUser, id: string, chunks: number) =>
      new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`${ws}/meetings/${id}/audio`, { headers: as(who) } as never);
        socket.onerror = () => reject(new Error("audio socket failed"));
        socket.onopen = async () => {
          for (let i = 0; i < chunks; i++) socket.send(new Uint8Array(3200));
          await Bun.sleep(300);
          socket.close();
          resolve();
        };
      });
    const until = async (check: () => Promise<boolean>, ms = 5_000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await check()) return;
        await Bun.sleep(25);
      }
      throw new Error("condition not met in time");
    };

    test("two users run live meetings at the same time", async () => {
      const one = await startLive(carol, "carol");
      const two = await startLive(dave, "dave");
      expect(one.status).toBe(201);
      expect(two.status).toBe(201);
      expect(one.json.id).not.toBe(two.json.id);
      expect(controller.activeMeetingId(carol.id)).toBe(one.json.id!);
      expect(controller.activeMeetingId(dave.id)).toBe(two.json.id!);
    });

    test("a user's second start is refused with their own meeting id, and never another user's", async () => {
      const mine = controller.activeMeetingId(carol.id)!;
      const again = await startLive(carol, "again");
      expect(again.status).toBe(409);
      expect(again.json.meetingId).toBe(mine);
      const his = await startLive(dave, "again");
      expect(his.status).toBe(409);
      expect(his.json.meetingId).toBe(controller.activeMeetingId(dave.id)!);
      expect(his.json.meetingId).not.toBe(mine);
    });

    test("audio from each user lands only in that user's meeting", async () => {
      const c = controller.activeMeetingId(carol.id)!;
      const d = controller.activeMeetingId(dave.id)!;
      await Promise.all([sendAudio(carol, c, 3), sendAudio(dave, d, 1)]);
      await until(async () => (await segments.head(c)) === 3 && (await segments.head(d)) === 1);
      expect(await segments.head(c)).toBe(3);
      expect(await segments.head(d)).toBe(1);
    });

    test("ending one user's meeting leaves the other's running, and frees the first user to start again", async () => {
      const c = controller.activeMeetingId(carol.id)!;
      const d = controller.activeMeetingId(dave.id)!;
      expect((await call(carol, "POST", `/meetings/${c}/end`)).status).toBe(200);
      expect(controller.activeMeetingId(carol.id)).toBeNull();
      expect(controller.activeMeetingId(dave.id)).toBe(d);
      expect(controller.sourceOf(d)).toBe("live");
      const next = await startLive(carol, "carol again");
      expect(next.status).toBe(201);
    });

    test("a user who is not signed in cannot start, and is not counted as a user", async () => {
      expect((await call(null, "POST", "/meetings", { source: "live" })).status).toBe(401);
    });
  });
});
