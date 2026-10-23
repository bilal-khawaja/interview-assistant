import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BUDGET_EXHAUSTED_NOTICE, TURN_FAILED_NOTICE } from "../constants/chat";
import { createDb, type DbClient } from "../db/client";
import { ChatBudgetRepository } from "../db/repositories/chat-budget.repository";
import { ChatInboxRepository } from "../db/repositories/chat-inbox.repository";
import { ChatMessageRepository } from "../db/repositories/chat-message.repository";
import { ChatSurfacedTermsRepository } from "../db/repositories/chat-surfaced-terms.repository";
import { CursorRepository } from "../db/repositories/cursor.repository";
import { ChatRepository, MeetingRepository } from "../db/repositories/meeting.repository";
import { SegmentRepository } from "../db/repositories/segment.repository";
import { chatMessages, meetings as meetingsTable, type TranscriptSegment } from "../db/schema";
import { env } from "../env";
import { CursorService } from "../log/cursor";
import { TranscriptConsumer } from "../log/consumer";
import { WakeHub } from "../log/wake";
import type { ChatAgent } from "./agent";
import { runChatConsumer } from "./chat-consumer";
import { KeyedCoordinator } from "./keyed-coordinator";
import { ChatRunner, TurnAbortedError } from "./runner";
import { StubChatAgent } from "./stub-agent";

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const id = () => crypto.randomUUID();

async function until(cond: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(10);
  }
  throw new Error("condition not met in time");
}

run("ChatRunner", () => {
  const db = client?.db as DbClient["db"];
  const messages = new ChatMessageRepository(db);
  const inbox = new ChatInboxRepository(db);
  const terms = new ChatSurfacedTermsRepository(db);
  const budgets = new ChatBudgetRepository(db);
  const cursors = new CursorRepository(db);
  let meetingId: string;
  const errors: unknown[] = [];

  const newChat = async (title: string) => (await new ChatRepository(db).create(meetingId, title)).id;
  const make = (agent: ChatAgent, tokenLimit?: number) =>
    new ChatRunner({
      db,
      coordinator: new KeyedCoordinator(),
      agent,
      tokenLimit,
      onError: (e) => errors.push(e),
    });
  const content = async (chatId: string) => (await messages.tail(chatId, 50)).map((m) => `${m.role}/${m.kind}:${m.content}`);
  const segment = (seq: number, text: string): TranscriptSegment => ({
    id: seq,
    meetingId,
    seq,
    speakerKey: "spk_0",
    text,
    startMs: seq * 1000,
    endMs: seq * 1000 + 900,
    source: "stt",
    createdAt: new Date(),
  });

  beforeAll(async () => {
    meetingId = (await new MeetingRepository(db).create("chat runner test")).id;
  });

  afterAll(async () => {
    await db.delete(meetingsTable).where(eq(meetingsTable.id, meetingId));
    await client!.close();
  });

  test("a user message gets one reply and the budget is charged", async () => {
    const chat = await newChat("reply");
    const runner = make(new StubChatAgent());
    const { done } = await runner.submit(chat, id(), "followup", "hello");
    await done;
    expect(await content(chat)).toEqual(["user/followup:hello", "assistant/reply:re: hello"]);
    expect((await budgets.get(chat))?.tokensUsed).toBe(120);
    expect(await inbox.pending(chat)).toHaveLength(0);
  });

  test("each promoted message gets its own turn, in order", async () => {
    const chat = await newChat("one-per-message");
    const agent = new StubChatAgent({ delayMs: 30 });
    const runner = make(agent);
    const a = await runner.submit(chat, id(), "followup", "first");
    await runner.submit(chat, id(), "followup", "second");
    const c = await runner.submit(chat, id(), "followup", "third");
    await Promise.all([a.done, c.done]);
    await runner.input.drain(chat);
    expect(await content(chat)).toEqual([
      "user/followup:first",
      "assistant/reply:re: first",
      "user/followup:second",
      "assistant/reply:re: second",
      "user/followup:third",
      "assistant/reply:re: third",
    ]);
    expect(agent.calls.filter((c) => c.trigger === "user")).toHaveLength(3);
  });

  test("a steer aborts the running turn and is answered before queued follow-ups", async () => {
    const chat = await newChat("steer");
    const agent = new StubChatAgent({ delayMs: 150 });
    const runner = make(agent);
    const first = await runner.submit(chat, id(), "followup", "slow question");
    await until(() => agent.calls.length >= 1);
    await sleep(40);
    await runner.submit(chat, id(), "followup", "later question");
    await runner.submit(chat, id(), "steer", "change course");
    await first.done;
    await runner.processInputs(chat);
    expect(await content(chat)).toEqual([
      "user/followup:slow question",
      "user/steer:change course",
      "assistant/reply:re: change course",
      "user/followup:later question",
      "assistant/reply:re: later question",
    ]);
    expect((await budgets.get(chat))?.tokensUsed).toBe(240);
  });

  test("a transcript turn saves a suggestion, surfaces terms, advances the cursor and charges", async () => {
    const chat = await newChat("transcript");
    const runner = make(new StubChatAgent());
    await runner.handleTranscript(chat, [segment(1, "We talked about Postgres today"), segment(2, "and Kafka too")]);
    expect(await content(chat)).toEqual(["assistant/suggestion:suggestion for 1-2"]);
    expect((await terms.list(chat)).map((t) => t.termNorm).sort()).toEqual(["kafka", "postgres"]);
    expect((await cursors.get(chat))?.lastSeenSeq).toBe(2);
    expect((await budgets.get(chat))?.tokensUsed).toBe(120);
    expect((await messages.tail(chat, 1))[0]?.transcriptSeq).toBe(2);
  });

  test("a batch that only repeats surfaced terms makes no suggestion but still advances", async () => {
    const chat = await newChat("repeat");
    const runner = make(new StubChatAgent());
    await runner.handleTranscript(chat, [segment(1, "Postgres")]);
    await runner.handleTranscript(chat, [segment(2, "Postgres again")]);
    const suggestions = (await content(chat)).filter((c) => c.startsWith("assistant/suggestion"));
    expect(suggestions).toHaveLength(1);
    await runner.handleTranscript(chat, [segment(3, "Postgres")]);
    expect((await content(chat)).filter((c) => c.startsWith("assistant/suggestion"))).toHaveLength(1);
    expect((await cursors.get(chat))?.lastSeenSeq).toBe(3);
  });

  test("a steer aborts a transcript turn: nothing committed, cursor stays", async () => {
    const chat = await newChat("transcript-abort");
    const agent = new StubChatAgent({ delayMs: 200 });
    const runner = make(agent);
    const turn = runner.handleTranscript(chat, [segment(1, "Postgres")]);
    const settled = turn.then(
      () => null,
      (e) => e,
    );
    await until(() => agent.calls.length >= 1);
    runner.steer(chat);
    expect(await settled).toBeInstanceOf(TurnAbortedError);
    expect(await content(chat)).toEqual([]);
    expect(await cursors.get(chat)).toBeNull();
    expect((await budgets.get(chat))?.tokensUsed ?? 0).toBe(0);
  });

  test("an exhausted budget skips the model, notes it once and still advances", async () => {
    const chat = await newChat("budget");
    const agent = new StubChatAgent();
    const runner = make(agent, 100);
    await runner.handleTranscript(chat, [segment(1, "Postgres")]);
    const calls = agent.calls.length;
    await runner.handleTranscript(chat, [segment(2, "Kafka")]);
    await runner.handleTranscript(chat, [segment(3, "Redis")]);
    expect(agent.calls.length).toBe(calls);
    const notices = (await content(chat)).filter((c) => c === `system/notice:${BUDGET_EXHAUSTED_NOTICE}`);
    expect(notices).toHaveLength(1);
    expect((await cursors.get(chat))?.lastSeenSeq).toBe(3);
    await (await runner.submit(chat, id(), "followup", "hi")).done;
    expect((await content(chat)).at(-1)).toBe(`system/notice:${BUDGET_EXHAUSTED_NOTICE}`);
  });

  test("a failing model on a user turn leaves a notice and does not throw", async () => {
    const chat = await newChat("agent-fails");
    const runner = make(new StubChatAgent({ fail: () => new Error("model down") }));
    await (await runner.submit(chat, id(), "followup", "hi")).done;
    expect((await content(chat)).at(-1)).toBe(`system/notice:${TURN_FAILED_NOTICE}`);
    expect((await budgets.get(chat))?.tokensUsed).toBe(0);
  });

  test("a failing model on a transcript turn rethrows and commits nothing", async () => {
    const chat = await newChat("transcript-fails");
    const runner = make(new StubChatAgent({ fail: () => new Error("model down") }));
    await expect(runner.handleTranscript(chat, [segment(1, "Postgres")])).rejects.toThrow("model down");
    expect(await content(chat)).toEqual([]);
    expect(await cursors.get(chat)).toBeNull();
  });

  test("recover answers a promoted message that never got a reply", async () => {
    const chat = await newChat("recover");
    await messages.append(chat, { id: id(), role: "user", kind: "followup", content: "orphan" });
    const pendingId = id();
    const other = await newChat("recover-pending");
    await inbox.admit(other, pendingId, "followup", "waiting");
    const runner = make(new StubChatAgent());
    await runner.recover();
    expect((await content(chat)).at(-1)).toBe("assistant/reply:re: orphan");
    expect((await content(other)).at(-1)).toBe("assistant/reply:re: waiting");
  });

  test("chats stay independent: history, terms and budget", async () => {
    const a = await newChat("iso-a");
    const b = await newChat("iso-b");
    const runner = make(new StubChatAgent({ delayMs: 20 }));
    await Promise.all([
      runner.handleTranscript(a, [segment(1, "Postgres")]),
      runner.handleTranscript(b, [segment(1, "Postgres")]),
      runner.submit(a, id(), "followup", "for a").then((s) => s.done),
    ]);
    expect((await terms.list(a)).map((t) => t.termNorm)).toEqual(["postgres"]);
    expect((await terms.list(b)).map((t) => t.termNorm)).toEqual(["postgres"]);
    expect((await content(b)).some((c) => c.includes("for a"))).toBe(false);
    expect((await budgets.get(b))?.tokensUsed).toBe(120);
    expect((await budgets.get(a))?.tokensUsed).toBe(240);
  });

  test("the chat consumer turns transcript batches into suggestions and resumes from its cursor", async () => {
    const chat = await newChat("consumer");
    const segmentsRepo = new SegmentRepository(db);
    await segmentsRepo.appendIgnore([1, 2, 3].map((n) => ({ meetingId, seq: n, text: `Topic${n} Alpha`, startMs: n, endMs: n + 1 })));
    const runner = make(new StubChatAgent());
    const hub = new WakeHub();
    const consumer = new TranscriptConsumer({
      hub,
      readAfter: (m, after, limit) => segmentsRepo.readAfter(m, after, limit),
      sql: client!.sql,
      cursors: new CursorService({ chats: new ChatRepository(db), cursors, segments: segmentsRepo }),
      pollMs: 30,
    });
    const abort = new AbortController();
    const finished = runChatConsumer({
      consumer,
      runner,
      cursors: new CursorService({ chats: new ChatRepository(db), cursors, segments: segmentsRepo }),
      meetingId,
      chatId: chat,
      signal: abort.signal,
      onError: (e) => errors.push(e),
    });
    await until(async () => ((await cursors.get(chat))?.lastSeenSeq ?? 0) >= 3);
    abort.abort();
    await finished;
    expect((await content(chat))[0]).toBe("assistant/suggestion:suggestion for 1-3");
    expect((await budgets.get(chat))?.tokensUsed).toBe(120);
  });
});
