import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { websocket } from "hono/bun";
import { fakeAuth, type FakeUser } from "../auth/testing";
import type { ChatAgent, ChatAgentResult, ChatTurn } from "../chat/agent";
import { ChatHost } from "../chat/host";
import { KeyedCoordinator } from "../chat/keyed-coordinator";
import { ChatRunner } from "../chat/runner";
import { createDb, type DbClient } from "../db/client";
import { ChatMessageRepository } from "../db/repositories/chat-message.repository";
import { CursorRepository } from "../db/repositories/cursor.repository";
import { ChatRepository, MeetingRepository } from "../db/repositories/meeting.repository";
import { MeetingParticipantRepository } from "../db/repositories/participant.repository";
import { SegmentRepository } from "../db/repositories/segment.repository";
import { meetings as meetingsTable, transcriptSegments, user } from "../db/schema";
import { env } from "../env";
import { TranscriptConsumer } from "../log/consumer";
import { CursorService } from "../log/cursor";
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

const tag = crypto.randomUUID().slice(0, 8);
const person = (name: string): FakeUser => ({ id: `iso-${tag}-${name}`, email: `iso-${tag}-${name}@example.test`, name });
const alice = person("alice");
const bob = person("bob");

/** A live source with no Deepgram: each audio chunk pushed in becomes one segment, worded with its owner's name. */
class OwnedEchoSource extends LiveAudioSource {
  pushed = 0;
  constructor(private readonly owner: string) {
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
          yield { text: `${self.owner} said line ${seen}`, startMs: seen * 1000, endMs: seen * 1000 + 900 };
          seen++;
        } else {
          await Bun.sleep(10);
        }
      }
    })();
  }
}

/**
 * Stands in for the model. It records every turn it is given and answers each transcript turn
 * with the lines it was shown, so whatever reaches a chat can be read back from that chat.
 */
class RecordingAgent implements ChatAgent {
  readonly turns: { meetingIds: string[]; texts: string[] }[] = [];
  async respond(turn: ChatTurn): Promise<ChatAgentResult> {
    this.turns.push({ meetingIds: turn.transcript.map((s) => s.meetingId), texts: turn.transcript.map((s) => s.text) });
    const usage = { tokensIn: 1, tokensOut: 1, costMicros: 0 };
    if (turn.trigger === "user") return { text: "ok", terms: [], usage };
    return { text: `saw: ${turn.transcript.map((s) => s.text).join(" | ")}`, terms: [], usage };
  }
}

run("accounts do not share meetings, transcripts or chats (postgres)", () => {
  const { db, sql } = client ?? ({} as DbClient);
  const meetings = new MeetingRepository(db);
  const chats = new ChatRepository(db);
  const segments = new SegmentRepository(db);
  const transcriptHub = new WakeHub();
  const chatHub = new WakeHub();
  const bridges = [new PgWakeBridge(sql, transcriptHub), new PgWakeBridge(sql, chatHub, "chat_messages")];
  const agent = new RecordingAgent();
  const created: string[] = [];
  let controller: MeetingController;
  let host: ChatHost;
  let server: ReturnType<typeof Bun.serve>;
  let http = "";
  let ws = "";
  let aliceMeeting = "";
  let bobMeeting = "";
  let aliceChat = "";
  let bobChat = "";
  const owners = [alice.name, bob.name];

  const as = (who: FakeUser) => ({ authorization: `Bearer ${who.id}` });
  const call = (who: FakeUser, method: string, path: string, body?: unknown) =>
    fetch(`${http}${path}`, {
      method,
      headers: { ...as(who), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const json = async <T>(response: Response) => (await response.json()) as T;
  const until = async (check: () => Promise<boolean> | boolean, ms = 8_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await Bun.sleep(25);
    }
    throw new Error("condition not met in time");
  };
  const speak = (who: FakeUser, meetingId: string, lines: number) =>
    new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`${ws}/meetings/${meetingId}/audio`, { headers: as(who) } as never);
      socket.onerror = () => reject(new Error("audio socket failed"));
      socket.onopen = async () => {
        for (let i = 0; i < lines; i++) {
          socket.send(new Uint8Array(3200));
          await Bun.sleep(15);
        }
        await Bun.sleep(200);
        socket.close();
        resolve();
      };
    });
  const chatMessages = async (who: FakeUser, meetingId: string, chatId: string) =>
    (await json<{ messages: { content: string; role: string }[] }>(await call(who, "GET", `/meetings/${meetingId}/chats/${chatId}/messages`))).messages;

  beforeAll(async () => {
    await db.insert(user).values([alice, bob].map((u) => ({ id: u.id, name: u.name, email: u.email })));
    await Promise.all(bridges.map((bridge) => bridge.start()));
    const cursors = new CursorService({ chats, cursors: new CursorRepository(db), segments });
    const runner = new ChatRunner({
      db,
      coordinator: new KeyedCoordinator(),
      agent,
      suggestions: true,
      onError: () => undefined,
    });
    host = new ChatHost({
      runner,
      consumer: new TranscriptConsumer({
        hub: transcriptHub,
        readAfter: (m, after, limit) => segments.readAfter(m, after, limit),
        sql,
        cursors,
        pollMs: 30,
      }),
      cursors,
      onError: () => undefined,
    });
    let sources = 0;
    controller = new MeetingController({
      sql,
      meetings,
      segments,
      chats,
      runner,
      host,
      deepgramApiKey: "test-key",
      endTimeoutMs: 5_000,
      appender: { retryBaseMs: 5, lockCheckMs: 0 },
      log: () => undefined,
      createLiveSource: () => new OwnedEchoSource(owners[sources++]!),
    });
    const app = createApp({
      auth: fakeAuth({ [alice.id]: alice, [bob.id]: bob }),
      meetings,
      segments,
      participants: new MeetingParticipantRepository(db),
      hub: transcriptHub,
      heartbeatMs: 1_000,
      maxBufferedBytes: 1_000_000,
      meetingApi: controller,
      chat: {
        runner,
        host,
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

    // Alice first, then Bob, so the sources above are worded with the right names. Both stay live.
    const a = await json<{ id: string }>(await call(alice, "POST", "/meetings", { source: "live", title: "alice meeting" }));
    const b = await json<{ id: string }>(await call(bob, "POST", "/meetings", { source: "live", title: "bob meeting" }));
    aliceMeeting = a.id;
    bobMeeting = b.id;
    created.push(aliceMeeting, bobMeeting);
    aliceChat = (await chats.listByMeeting(aliceMeeting))[0]!.id;
    bobChat = (await chats.listByMeeting(bobMeeting))[0]!.id;
  });

  afterAll(async () => {
    await controller?.shutdown();
    await host?.stop();
    await server?.stop(true);
    await Promise.all(bridges.map((bridge) => bridge.stop()));
    if (created.length) await db.delete(meetingsTable).where(inArray(meetingsTable.id, created));
    await db.delete(user).where(inArray(user.id, [alice.id, bob.id]));
    await client?.close();
  });

  test("both accounts are live at the same time, each with its own chat from the start", async () => {
    expect(aliceMeeting).not.toBe(bobMeeting);
    expect(controller.activeMeetingId(alice.id)).toBe(aliceMeeting);
    expect(controller.activeMeetingId(bob.id)).toBe(bobMeeting);
    expect(aliceChat).not.toBe(bobChat);
  });

  test("speaking in both meetings at once: every chat only ever sees its own meeting's lines", async () => {
    await Promise.all([speak(alice, aliceMeeting, 4), speak(bob, bobMeeting, 3)]);
    await until(async () => (await segments.head(aliceMeeting)) === 4 && (await segments.head(bobMeeting)) === 3);
    await until(async () => {
      const [a, b] = await Promise.all([chatMessages(alice, aliceMeeting, aliceChat), chatMessages(bob, bobMeeting, bobChat)]);
      const text = (messages: { content: string }[]) => messages.map((m) => m.content).join(" ");
      return text(a).includes("line 3") && text(b).includes("line 2");
    });

    const aliceText = (await chatMessages(alice, aliceMeeting, aliceChat)).map((m) => m.content).join("\n");
    const bobText = (await chatMessages(bob, bobMeeting, bobChat)).map((m) => m.content).join("\n");
    expect(aliceText).toContain("alice said line 0");
    expect(aliceText).not.toContain("bob");
    expect(bobText).toContain("bob said line 0");
    expect(bobText).not.toContain("alice");
  }, 30_000);

  test("no model turn was ever given lines from two meetings, or from a meeting it was not for", () => {
    expect(agent.turns.length).toBeGreaterThan(0);
    for (const turn of agent.turns) {
      expect(new Set(turn.meetingIds).size).toBeLessThanOrEqual(1);
      const owner = turn.meetingIds[0] === aliceMeeting ? "alice" : "bob";
      const other = owner === "alice" ? "bob" : "alice";
      expect(turn.texts.some((text) => text.startsWith(other))).toBe(false);
    }
  });

  test("each chat's reading position follows its own meeting, not the other's", async () => {
    const cursors = new CursorRepository(db);
    expect((await cursors.get(aliceChat))?.lastSeenSeq).toBe(4);
    expect((await cursors.get(bobChat))?.lastSeenSeq).toBe(3);
  });

  test("a chat stream opened by one account never carries the other's lines", async () => {
    const frames: string[] = [];
    const open = (who: FakeUser, meetingId: string, chatId: string) =>
      new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(`${ws}/meetings/${meetingId}/chats/${chatId}/stream?after=0`, { headers: as(who) } as never);
        socket.onmessage = (event) => frames.push(`${who.name}:${String(event.data)}`);
        socket.onopen = () => resolve(socket);
        socket.onerror = () => reject(new Error("chat stream failed"));
      });
    const sockets = await Promise.all([open(alice, aliceMeeting, aliceChat), open(bob, bobMeeting, bobChat)]);
    await until(() => frames.some((f) => f.startsWith("alice:") && f.includes("alice said")) && frames.some((f) => f.startsWith("bob:") && f.includes("bob said")));
    sockets.forEach((socket) => socket.close());
    expect(frames.filter((f) => f.startsWith("alice:")).some((f) => f.includes("bob said"))).toBe(false);
    expect(frames.filter((f) => f.startsWith("bob:")).some((f) => f.includes("alice said"))).toBe(false);
  });

  test("transcript streams are likewise separate, and the other account cannot open them", async () => {
    const read = (who: FakeUser, meetingId: string) =>
      new Promise<string[]>((resolve) => {
        const lines: string[] = [];
        const socket = new WebSocket(`${ws}/meetings/${meetingId}/stream?after=0`, { headers: as(who) } as never);
        socket.onmessage = (event) => lines.push(String(event.data));
        socket.onerror = () => resolve(lines);
        setTimeout(() => (socket.close(), resolve(lines)), 600);
      });
    const own = await read(alice, aliceMeeting);
    expect(own.some((f) => f.includes("alice said line 3"))).toBe(true);
    expect(own.some((f) => f.includes("bob said"))).toBe(false);
    expect(await read(bob, aliceMeeting)).toEqual([]);
  });

  test("ending one account's meeting does not touch the other's chat or transcript", async () => {
    expect((await call(alice, "POST", `/meetings/${aliceMeeting}/end`)).status).toBe(200);
    expect(controller.activeMeetingId(bob.id)).toBe(bobMeeting);
    await speak(bob, bobMeeting, 1);
    await until(async () => (await segments.head(bobMeeting)) === 4);
    await until(async () => (await chatMessages(bob, bobMeeting, bobChat)).some((m) => m.content.includes("line 3")));
    expect((await chatMessages(alice, aliceMeeting, aliceChat)).some((m) => m.content.includes("bob"))).toBe(false);
  });
});
