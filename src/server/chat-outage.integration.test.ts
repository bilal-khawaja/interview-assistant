import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { websocket } from "hono/bun";
import { KeyedCoordinator } from "../chat/keyed-coordinator";
import { ChatRunner } from "../chat/runner";
import { StubChatAgent } from "../chat/stub-agent";
import { createDb, type DbClient } from "../db/client";
import { ChatBudgetRepository } from "../db/repositories/chat-budget.repository";
import { ChatMessageRepository } from "../db/repositories/chat-message.repository";
import { ChatRepository, MeetingRepository } from "../db/repositories/meeting.repository";
import { MeetingParticipantRepository } from "../db/repositories/participant.repository";
import { SegmentRepository } from "../db/repositories/segment.repository";
import { chatMessages, meetings as meetingsTable } from "../db/schema";
import { env } from "../env";
import { PgWakeBridge, WakeHub } from "../log/wake";
import { createApp } from "./app";
import type { Frame, MessageFrame } from "./frames";

/**
 * Stops and starts the real Postgres container, so it only runs when PG_CONTAINER names it:
 *   PG_CONTAINER=pgvector-db bun test src/server/chat-outage.integration.test.ts
 */
const container = process.env.PG_CONTAINER;

async function probe(): Promise<DbClient | null> {
  if (!container || !env.DATABASE_URL) return null;
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function docker(...args: string[]): Promise<void> {
  const proc = Bun.spawn(["docker", ...args], { stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`docker ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
}

async function until(cond: () => boolean | Promise<boolean>, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await cond()) return;
    } catch {
      // not yet
    }
    await sleep(100);
  }
  throw new Error("condition not met in time");
}

run("chat across a real database stop and start", () => {
  const { db, sql } = client ?? ({} as DbClient);
  const chatHub = new WakeHub();
  const bridge = new PgWakeBridge(sql, chatHub, "chat_messages");
  const frames: Frame[] = [];
  let meetingId: string;
  let chatId: string;
  let server: ReturnType<typeof Bun.serve>;
  let socket: WebSocket;
  let http = "";
  let stopped = false;

  const messageSeqs = () => frames.filter((f): f is MessageFrame => f.type === "message").map((f) => f.seq);
  const has = (type: string) => frames.some((f) => f.type === type);
  /** A client retries the same messageId until the server accepts it. */
  const postUntilAccepted = async (messageId: string, text: string) => {
    await until(async () => {
      const response = await fetch(`${http}/meetings/${meetingId}/chats/${chatId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messageId, text }),
      }).catch(() => null);
      return response !== null && response.status < 300;
    }, 60_000);
  };

  beforeAll(async () => {
    meetingId = (await new MeetingRepository(db).create("outage test")).id;
    chatId = (await new ChatRepository(db).create(meetingId, "outage")).id;
    await bridge.start();
    const runner = new ChatRunner({ db, coordinator: new KeyedCoordinator(), agent: new StubChatAgent() });
    await runner.open(chatId);
    const app = createApp({
      meetings: new MeetingRepository(db),
      segments: new SegmentRepository(db),
      participants: new MeetingParticipantRepository(db),
      hub: new WakeHub(),
      heartbeatMs: 200,
      maxBufferedBytes: 1_000_000,
      chat: {
        runner,
        host: { start: () => undefined },
        chats: new ChatRepository(db),
        messages: new ChatMessageRepository(db),
        hub: chatHub,
        heartbeatMs: 200,
        maxBufferedBytes: 1_000_000,
        pollMs: 200,
        retryBaseMs: 100,
        retryMaxMs: 500,
      },
    });
    server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
    http = `http://localhost:${server.port}`;
    socket = new WebSocket(`ws://localhost:${server.port}/meetings/${meetingId}/chats/${chatId}/stream`);
    socket.onmessage = (event) => frames.push(JSON.parse(String(event.data)) as Frame);
  });

  afterAll(async () => {
    if (stopped) await docker("start", container!);
    socket?.close();
    await server?.stop(true);
    await until(async () => {
      await db.delete(meetingsTable).where(eq(meetingsTable.id, meetingId));
      return true;
    }, 60_000).catch(() => undefined);
    await bridge.stop().catch(() => undefined);
    await client?.close();
  });

  test("the stream reports the outage, recovers, and the conversation continues without gaps", async () => {
    await postUntilAccepted(crypto.randomUUID(), "before");
    await until(() => messageSeqs().length === 2, 10_000);

    stopped = true;
    await docker("stop", container!);
    await until(() => has("degraded"), 15_000);

    // a client keeps retrying the same id while the database is down
    const during = crypto.randomUUID();
    const sending = postUntilAccepted(during, "during");

    await docker("start", container!);
    stopped = false;
    await until(() => has("recovered"), 60_000);
    await sending;

    await until(() => messageSeqs().length === 4, 30_000);
    expect(messageSeqs()).toEqual([1, 2, 3, 4]);
    const rows = await new ChatMessageRepository(db).tail(chatId, 50);
    expect(rows.map((m) => m.content)).toEqual(["before", "re: before", "during", "re: during"]);
    expect((await new ChatBudgetRepository(db).get(chatId))?.tokensUsed).toBe(240);
  }, 120_000);
});
