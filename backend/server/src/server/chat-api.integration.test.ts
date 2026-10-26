import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { websocket } from "hono/bun";
import { KeyedCoordinator } from "../chat/keyed-coordinator";
import { ChatRunner } from "../chat/runner";
import { StubChatAgent } from "../chat/stub-agent";
import { createDb, type DbClient } from "../db/client";
import { ChatInboxRepository } from "../db/repositories/chat-inbox.repository";
import { ChatMessageRepository } from "../db/repositories/chat-message.repository";
import { MeetingParticipantRepository } from "../db/repositories/participant.repository";
import { ChatRepository, MeetingRepository } from "../db/repositories/meeting.repository";
import { SegmentRepository } from "../db/repositories/segment.repository";
import { chatMessages, meetings as meetingsTable } from "../db/schema";
import { env } from "../env";
import { PgWakeBridge, WakeHub } from "../log/wake";
import { createApp } from "./app";
import type { Frame, MessageFrame } from "./frames";

async function probe(): Promise<DbClient | null> {
  if (!env.DATABASE_URL) return null;
  try {
    const client = createDb(env.DATABASE_URL);
    await client.db.select().from(chatMessages).limit(0);
    return client;
  } catch {
    return null;
  }
}

const client = await probe();
const run = client ? describe : describe.skip;
const id = () => crypto.randomUUID();

type Socket = {
  frames: Frame[];
  closed: Promise<{ code: number; reason: string }>;
  waitFor(predicate: (frames: Frame[]) => boolean, ms?: number): Promise<void>;
  close(): void;
};

function connect(url: string): Socket {
  const ws = new WebSocket(url);
  const frames: Frame[] = [];
  const listeners = new Set<() => void>();
  ws.onmessage = (event) => {
    frames.push(JSON.parse(String(event.data)) as Frame);
    for (const listener of listeners) listener();
  };
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.onclose = (event) => resolve({ code: event.code, reason: event.reason });
  });
  return {
    frames,
    closed,
    waitFor(predicate, ms = 5_000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          if (!predicate(frames)) return;
          listeners.delete(check);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`timed out; frames=${JSON.stringify(frames.map((f) => f.type))}`));
        }, ms);
        listeners.add(check);
        check();
      });
    },
    close: () => ws.close(),
  };
}

const messageFrames = (frames: Frame[]) => frames.filter((f): f is MessageFrame => f.type === "message");

run("chat API (postgres)", () => {
  const { db, sql } = client ?? ({} as DbClient);
  const meetings = new MeetingRepository(db);
  const chats = new ChatRepository(db);
  const messages = new ChatMessageRepository(db);
  const chatHub = new WakeHub();
  const bridge = new PgWakeBridge(sql, chatHub, "chat_messages");
  const started: string[] = [];
  const attaches = new Map<string, unknown>();
  const errors: unknown[] = [];
  let meetingId: string;
  let server: ReturnType<typeof Bun.serve>;
  let http = "";
  let ws = "";

  const post = (chatId: string, body: unknown, meeting = meetingId) =>
    fetch(`${http}/meetings/${meeting}/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const newChat = async () => {
    const response = await fetch(`${http}/meetings/${meetingId}/chats`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "api" }),
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { id: string }).id;
  };
  const list = async (chatId: string, query = "") =>
    (await (await fetch(`${http}/meetings/${meetingId}/chats/${chatId}/messages${query}`)).json()) as {
      messages: { seq: number; role: string; content: string }[];
      head: number;
    };
  const until = async (cond: () => Promise<boolean>, ms = 5_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("condition not met in time");
  };

  beforeAll(async () => {
    meetingId = (await meetings.create("chat api test")).id;
    await bridge.start();
    const runner = new ChatRunner({
      db,
      coordinator: new KeyedCoordinator(),
      agent: new StubChatAgent(),
      onError: (e) => errors.push(e),
    });
    const app = createApp({
      meetings,
      segments: new SegmentRepository(db),
      participants: new MeetingParticipantRepository(db),
      hub: new WakeHub(),
      heartbeatMs: 80,
      maxBufferedBytes: 1_000_000,
      chat: {
        runner,
        host: {
          start: (_meeting, chatId, attach) => {
            started.push(chatId);
            attaches.set(chatId, attach);
          },
        },
        chats,
        messages,
        hub: chatHub,
        heartbeatMs: 80,
        maxBufferedBytes: 1_000_000,
        pollMs: 5_000,
      },
    });
    server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
    http = `http://localhost:${server.port}`;
    ws = `ws://localhost:${server.port}`;
  });

  afterAll(async () => {
    await server?.stop(true);
    await bridge.stop();
    await db.delete(meetingsTable).where(eq(meetingsTable.id, meetingId));
    await client?.close();
  });

  test("creating a chat opens it and starts its transcript consumer", async () => {
    const chatId = await newChat();
    expect(started).toContain(chatId);
    expect(await list(chatId)).toEqual({ messages: [], head: 0 });
  });

  test("a chat created through the API reads the transcript from now on, not from the start", async () => {
    const chatId = await newChat();
    expect(attaches.get(chatId)).toEqual({ kind: "tail", tail: 0 });
  });

  test("a meeting's chats are listed oldest first, and an unknown meeting is not found", async () => {
    const first = await newChat();
    const second = await newChat();
    const response = await fetch(`${http}/meetings/${meetingId}/chats`);
    expect(response.status).toBe(200);
    const { chats: rows } = (await response.json()) as { chats: { id: string; meetingId: string; title: string }[] };
    const ids = rows.map((row) => row.id);
    expect(ids.indexOf(first)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(first)).toBeLessThan(ids.indexOf(second));
    expect(rows.find((row) => row.id === first)).toMatchObject({ meetingId, title: "api" });
    expect((await fetch(`${http}/meetings/${id()}/chats`)).status).toBe(404);
    expect((await fetch(`${http}/meetings/nope/chats`)).status).toBe(404);
  });

  test("a posted message is accepted, answered, and listed in seq order", async () => {
    const chatId = await newChat();
    const messageId = id();
    const response = await post(chatId, { messageId, text: "hello" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ messageId, created: true });

    await until(async () => (await list(chatId)).messages.length === 2);
    const { messages: rows, head } = await list(chatId);
    expect(rows.map((m) => `${m.seq}:${m.role}:${m.content}`)).toEqual(["1:user:hello", "2:assistant:re: hello"]);
    expect(head).toBe(2);
    expect(rows[0]).toMatchObject({ id: messageId, kind: "followup" });
  });

  test("re-posting the same messageId changes nothing and says so", async () => {
    const chatId = await newChat();
    const messageId = id();
    await post(chatId, { messageId, text: "once" });
    const again = await post(chatId, { messageId, text: "once" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ messageId, created: false });
    await until(async () => (await list(chatId)).messages.length === 2);
    await new Promise((r) => setTimeout(r, 100));
    expect((await list(chatId)).messages).toHaveLength(2);
    expect(await new ChatInboxRepository(db).pending(chatId)).toHaveLength(0);
  });

  test("a messageId already used in another chat is a conflict", async () => {
    const a = await newChat();
    const b = await newChat();
    const messageId = id();
    expect((await post(a, { messageId, text: "x" })).status).toBe(202);
    expect((await post(b, { messageId, text: "x" })).status).toBe(409);
  });

  test("bad input and unknown chats are rejected", async () => {
    const chatId = await newChat();
    expect((await post(chatId, "not json")).status).toBe(400);
    expect((await post(chatId, { text: "   " })).status).toBe(400);
    expect((await post(chatId, { text: "x", mode: "shout" })).status).toBe(400);
    expect((await post(chatId, { text: "x".repeat(8_001) })).status).toBe(400);
    expect((await post(id(), { text: "x" })).status).toBe(404);
    expect((await post("nope", { text: "x" })).status).toBe(404);
    expect((await fetch(`${http}/meetings/${meetingId}/chats/${chatId}/messages?after=-1`)).status).toBe(400);
    expect((await fetch(`${http}/meetings/${meetingId}/chats/${chatId}/messages?limit=0`)).status).toBe(400);
    expect((await fetch(`${http}/meetings/${id()}/chats`, { method: "POST" })).status).toBe(404);
  });

  test("a chat cannot be reached through another meeting", async () => {
    const other = (await meetings.create("other")).id;
    try {
      const chatId = await newChat();
      expect((await post(chatId, { text: "x" }, other)).status).toBe(404);
    } finally {
      await db.delete(meetingsTable).where(eq(meetingsTable.id, other));
    }
  });

  test("listing pages with after and limit", async () => {
    const chatId = await newChat();
    for (let i = 1; i <= 3; i++) await (await new ChatRunner({ db, coordinator: new KeyedCoordinator(), agent: new StubChatAgent() }).submit(chatId, id(), "followup", `q${i}`)).done;
    expect((await list(chatId)).messages).toHaveLength(6);
    const page = await list(chatId, "?after=2&limit=3");
    expect(page.messages.map((m) => m.seq)).toEqual([3, 4, 5]);
    expect(page.head).toBe(6);
    expect((await list(chatId, "?after=6")).messages).toEqual([]);
  });

  test("the stream replays history, follows new messages, and resumes without gaps or repeats", async () => {
    const chatId = await newChat();
    await post(chatId, { text: "first" });
    await until(async () => (await list(chatId)).messages.length === 2);

    const live = connect(`${ws}/meetings/${meetingId}/chats/${chatId}/stream?after=0`);
    await live.waitFor((f) => messageFrames(f).length === 2);
    const ready = live.frames[0]!;
    expect(ready).toMatchObject({ type: "ready", stream: "chat", chatId, after: 0, head: 2 });

    await post(chatId, { text: "second" });
    await live.waitFor((f) => messageFrames(f).length === 4);
    expect(messageFrames(live.frames).map((f) => f.seq)).toEqual([1, 2, 3, 4]);
    live.close();
    await live.closed;

    await post(chatId, { text: "third" });
    await until(async () => (await list(chatId)).messages.length === 6);
    const resumed = connect(`${ws}/meetings/${meetingId}/chats/${chatId}/stream?after=4`);
    await resumed.waitFor((f) => messageFrames(f).length === 2);
    expect(messageFrames(resumed.frames).map((f) => f.seq)).toEqual([5, 6]);
    expect(messageFrames(resumed.frames)[0]).toMatchObject({ role: "user", content: "third" });
    resumed.close();
  });

  test("the stream wakes on a commit from outside the server's own runner", async () => {
    const chatId = await newChat();
    const socket = connect(`${ws}/meetings/${meetingId}/chats/${chatId}/stream`);
    await socket.waitFor((f) => f.some((x) => x.type === "ready"));
    const started = Date.now();
    await messages.append(chatId, { role: "system", kind: "notice", content: "from elsewhere" });
    await socket.waitFor((f) => messageFrames(f).length === 1, 2_000);
    // pollMs is 5s, so arriving sooner means the NOTIFY woke the stream.
    expect(Date.now() - started).toBeLessThan(2_000);
    socket.close();
  });

  test("resuming beyond the head is refused", async () => {
    const chatId = await newChat();
    const socket = connect(`${ws}/meetings/${meetingId}/chats/${chatId}/stream?after=5`);
    await socket.waitFor((f) => f.some((x) => x.type === "error"));
    expect((await socket.closed).code).toBe(4409);
  });

  test("the stream rejects a bad cursor and unknown chats before upgrading", async () => {
    const chatId = await newChat();
    expect((await fetch(`${http}/meetings/${meetingId}/chats/${chatId}/stream?after=x`)).status).toBe(400);
    expect((await fetch(`${http}/meetings/${meetingId}/chats/${id()}/stream`)).status).toBe(404);
  });

  test("no handler errors were reported", () => {
    expect(errors).toEqual([]);
  });
});
