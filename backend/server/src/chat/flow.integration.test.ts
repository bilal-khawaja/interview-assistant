import { testOwner } from "../auth/testing";
import { eq, sql as rawSql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, type DbClient } from "../db/client";
import { ChatBudgetRepository } from "../db/repositories/chat-budget.repository";
import { ChatInboxRepository } from "../db/repositories/chat-inbox.repository";
import { ChatMessageRepository } from "../db/repositories/chat-message.repository";
import { ChatSurfacedTermsRepository } from "../db/repositories/chat-surfaced-terms.repository";
import { CursorRepository } from "../db/repositories/cursor.repository";
import { ChatRepository, MeetingRepository } from "../db/repositories/meeting.repository";
import { SegmentRepository } from "../db/repositories/segment.repository";
import { chatMessages, meetings as meetingsTable } from "../db/schema";
import { env } from "../env";
import { TranscriptConsumer } from "../log/consumer";
import { CursorService } from "../log/cursor";
import { WakeHub } from "../log/wake";
import type { ChatAgent, ChatAgentResult, ChatTurn } from "./agent";
import { runChatConsumer } from "./chat-consumer";
import { ChatHost } from "./host";
import { KeyedCoordinator } from "./keyed-coordinator";
import { ChatRunner } from "./runner";
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
const id = () => crypto.randomUUID();

async function until(cond: () => boolean | Promise<boolean>, ms = 8_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not met in time");
}

/** A model call that never returns, like a process that dies in the middle of it. */
class HangingAgent implements ChatAgent {
  calls = 0;
  respond(_turn: ChatTurn): Promise<ChatAgentResult> {
    this.calls++;
    return new Promise(() => undefined);
  }
}

run("chat flow (postgres)", () => {
  const db = client?.db as DbClient["db"];
  const messages = new ChatMessageRepository(db);
  const inbox = new ChatInboxRepository(db);
  const terms = new ChatSurfacedTermsRepository(db);
  const budgets = new ChatBudgetRepository(db);
  const cursors = new CursorRepository(db);
  const segments = new SegmentRepository(db);
  const errors: unknown[] = [];
  let meetingId: string;
  let nextSeq = 1;

  const newChat = async (title: string) => (await new ChatRepository(db).create(meetingId, title)).id;
  /** Each call is a separate "process": its own coordinator, so only the database is shared. */
  const makeRunner = (agent: ChatAgent, tokenLimit?: number) =>
    new ChatRunner({
      db,
      coordinator: new KeyedCoordinator(),
      agent,
      tokenLimit,
      onError: (e) => errors.push(e),
    });
  const content = async (chatId: string) =>
    (await messages.tail(chatId, 500)).map((m) => `${m.role}/${m.kind}:${m.content}`);
  const seqs = async (chatId: string) => (await messages.tail(chatId, 500)).map((m) => m.seq);
  const segment = (seq: number, text: string) => ({
    id: seq,
    meetingId,
    seq,
    speakerKey: "spk_0",
    text,
    startMs: seq * 1000,
    endMs: seq * 1000 + 900,
    source: "stt" as const,
    createdAt: new Date(),
  });
  const addSegments = (texts: string[]) =>
    segments.appendIgnore(
      texts.map((text) => ({ meetingId, seq: nextSeq, text, startMs: nextSeq++, endMs: nextSeq })),
    );
  const cursorService = () => new CursorService({ chats: new ChatRepository(db), cursors, segments });
  const startConsumer = (chatId: string, runner: ChatRunner, hub = new WakeHub(), onOutage?: (e: unknown, n: number) => void) => {
    const abort = new AbortController();
    const consumer = new TranscriptConsumer({
      hub,
      readAfter: (m, after, limit) => segments.readAfter(m, after, limit),
      sql: client!.sql,
      cursors: cursorService(),
      pollMs: 30,
    });
    const finished = runChatConsumer({
      consumer,
      runner,
      cursors: cursorService(),
      meetingId,
      chatId,
      signal: abort.signal,
      onError: (e) => errors.push(e),
      onOutage,
    });
    return { stop: async () => (abort.abort(), finished), finished };
  };

  beforeAll(async () => {
    meetingId = (await new MeetingRepository(db).create("chat flow test", await testOwner(db))).id;
  });

  afterAll(async () => {
    await db.delete(meetingsTable).where(eq(meetingsTable.id, meetingId));
    await client!.close();
  });

  describe("late chat", () => {
    /** Records every segment the chat's turns are given, and answers with nothing to say. */
    class RecordingAgent implements ChatAgent {
      readonly seen: number[] = [];
      async respond(turn: ChatTurn): Promise<ChatAgentResult> {
        this.seen.push(...turn.transcript.map((s) => s.seq));
        return { text: null, terms: [], usage: { tokensIn: 1, tokensOut: 1, costMicros: 0 } };
      }
    }

    const hostFor = (runner: ChatRunner) =>
      new ChatHost({
        runner,
        consumer: new TranscriptConsumer({
          hub: new WakeHub(),
          readAfter: (m, after, limit) => segments.readAfter(m, after, limit),
          sql: client!.sql,
          cursors: cursorService(),
          pollMs: 30,
        }),
        cursors: cursorService(),
        onError: (e) => errors.push(e),
      });

    test("a chat started with tail 0 skips what was said before it and reads what comes after", async () => {
      const chat = await newChat("late-tail");
      await addSegments(["one", "two", "three"]);
      const before = await segments.head(meetingId);

      const agent = new RecordingAgent();
      const host = hostFor(makeRunner(agent));
      host.start(meetingId, chat, { kind: "tail", tail: 0 });
      await until(async () => (await cursors.get(chat))?.lastSeenSeq === before);

      await addSegments(["four", "five"]);
      const after = await segments.head(meetingId);
      await until(() => agent.seen.includes(after));
      await host.stop();

      expect(agent.seen.every((seq) => seq > before)).toBe(true);
      expect(agent.seen).toContain(before + 1);
      expect((await cursors.get(chat))?.lastSeenSeq).toBe(after);
    });

    test("a chat started without an attach mode still replays the meeting from the start", async () => {
      const chat = await newChat("late-beginning");
      const agent = new RecordingAgent();
      const host = hostFor(makeRunner(agent));
      host.start(meetingId, chat);
      const head = await segments.head(meetingId);
      await until(() => agent.seen.includes(head));
      await host.stop();
      expect(Math.min(...agent.seen)).toBe(1);
    });
  });

  describe("crash mid-turn", () => {
    test("a user turn lost mid-model-call is answered once after restart", async () => {
      const chat = await newChat("crash-user");
      const dying = new HangingAgent();
      const messageId = id();
      await makeRunner(dying).submit(chat, messageId, "followup", "are you there?");
      await until(() => dying.calls === 1);
      // the first process is gone; its turn never commits. A new one recovers.
      const survivor = makeRunner(new StubChatAgent());
      await survivor.recover();
      expect(await content(chat)).toEqual(["user/followup:are you there?", "assistant/reply:re: are you there?"]);
      expect((await budgets.get(chat))?.tokensUsed).toBe(120);
      expect(await inbox.pending(chat)).toHaveLength(0);
      // recovering again finds nothing to do
      await survivor.recover();
      expect(await content(chat)).toHaveLength(2);
    });

    test("a transcript turn lost mid-model-call is redelivered and committed once", async () => {
      const chat = await newChat("crash-transcript");
      const dying = new HangingAgent();
      void makeRunner(dying).handleTranscript(chat, [segment(1, "Kafka rocks")]);
      await until(() => dying.calls === 1);
      expect(await cursors.get(chat)).toBeNull();
      expect(await content(chat)).toEqual([]);

      const survivor = makeRunner(new StubChatAgent());
      await survivor.handleTranscript(chat, [segment(1, "Kafka rocks")]);
      expect(await content(chat)).toEqual(["assistant/suggestion:suggestion for 1-1"]);
      expect((await cursors.get(chat))?.lastSeenSeq).toBe(1);
      expect((await budgets.get(chat))?.tokensUsed).toBe(120);
      expect((await terms.list(chat)).map((t) => t.termNorm)).toEqual(["kafka"]);
    });

    test("a failure on the last step of the commit keeps none of it, and the retry commits once", async () => {
      const chat = await newChat("crash-commit");
      // the cost overflows bigint, so the budget charge (after the message and terms) fails
      const broken: ChatAgent = {
        respond: async () => ({
          text: "Postgres tip",
          terms: ["Postgres"],
          usage: { tokensIn: 10, tokensOut: 5, costMicros: 1e30 },
        }),
      };
      await expect(makeRunner(broken).handleTranscript(chat, [segment(1, "Postgres")])).rejects.toThrow();
      expect(await content(chat)).toEqual([]);
      expect(await terms.list(chat)).toEqual([]);
      expect(await cursors.get(chat)).toBeNull();
      expect((await budgets.get(chat))?.tokensUsed).toBe(0);

      await makeRunner(new StubChatAgent()).handleTranscript(chat, [segment(1, "Postgres")]);
      expect(await content(chat)).toHaveLength(1);
      expect((await terms.list(chat)).map((t) => t.termNorm)).toEqual(["postgres"]);
      expect((await budgets.get(chat))?.tokensUsed).toBe(120);
    });

    test("two processes recovering the same unanswered message produce one reply and one charge", async () => {
      const chat = await newChat("crash-two-recoverers");
      await messages.append(chat, { id: id(), role: "user", kind: "followup", content: "orphan" });
      await Promise.all([
        makeRunner(new StubChatAgent({ delayMs: 40 })).recover(),
        makeRunner(new StubChatAgent({ delayMs: 40 })).recover(),
      ]);
      expect(await content(chat)).toEqual(["user/followup:orphan", "assistant/reply:re: orphan"]);
      expect((await budgets.get(chat))?.tokensUsed).toBe(120);
    });
  });

  describe("database restart", () => {
    const killOtherConnections = async () => {
      const admin = createDb(env.DATABASE_URL);
      try {
        await admin.db.execute(rawSql`
          SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()`);
      } finally {
        // The kill can take this client's own spare connection with it, and close() then waits forever.
        await Promise.race([admin.close(), new Promise((r) => setTimeout(r, 500))]);
      }
    };
    /** Repositories do not retry on their own; drain the dead pooled connections so the test's own queries work. */
    const reconnect = async () => {
      for (let i = 0; i < 20; i++) await db.execute(rawSql`SELECT 1`).catch(() => undefined);
    };

    test("a running consumer survives every connection being cut and loses nothing", async () => {
      const chat = await newChat("outage-consumer");
      const agent = new StubChatAgent();
      const runner = makeRunner(agent);
      const first = nextSeq;
      const consumer = startConsumer(chat, runner);
      await addSegments(["Alpha one"]);
      await until(async () => ((await cursors.get(chat))?.lastSeenSeq ?? 0) >= first);

      await killOtherConnections();
      await reconnect();
      await addSegments(["Bravo two"]);
      await addSegments(["Charlie three"]);
      await until(async () => ((await cursors.get(chat))?.lastSeenSeq ?? 0) >= first + 2, 15_000);
      await consumer.stop();

      const out = await content(chat);
      const surfaced = (await terms.list(chat)).map((t) => t.termNorm).sort();
      expect(surfaced).toEqual(["alpha", "bravo", "charlie"]);
      // every transcript position was handled by exactly one committed turn
      expect(out.filter((m) => m.startsWith("assistant/suggestion"))).toHaveLength(out.length);
      expect((await budgets.get(chat))?.tokensUsed).toBe(120 * out.length);
      expect(await seqs(chat)).toEqual(out.map((_, i) => i + 1));
    }, 30_000);

    test("user input still works once the pool has reconnected", async () => {
      const chat = await newChat("outage-user");
      const runner = makeRunner(new StubChatAgent());
      await (await runner.submit(chat, id(), "followup", "before")).done;
      await killOtherConnections();
      await reconnect();
      await (await runner.submit(chat, id(), "followup", "after")).done;
      await runner.processInputs(chat);
      expect((await content(chat)).filter((m) => m.startsWith("assistant/reply"))).toEqual([
        "assistant/reply:re: before",
        "assistant/reply:re: after",
      ]);
      expect((await budgets.get(chat))?.tokensUsed).toBe(240);
    }, 30_000);
  });

  describe("two chats on one meeting", () => {
    test("each chat has its own suggestions, cursor, terms, history and budget", async () => {
      const a = await newChat("two-a");
      const b = await newChat("two-b");
      const agent = new StubChatAgent({ delayMs: 10 });
      const runnerA = makeRunner(agent);
      const runnerB = makeRunner(agent, 150);
      const base = nextSeq;
      const ca = startConsumer(a, runnerA);
      const cb = startConsumer(b, runnerB);
      await addSegments(["Delta one", "Echo two"]);
      await until(async () => ((await cursors.get(a))?.lastSeenSeq ?? 0) > base && ((await cursors.get(b))?.lastSeenSeq ?? 0) > base);

      // b has a 150 token limit: one 120 token turn leaves 30, the next turn exhausts it
      await addSegments(["Foxtrot three"]);
      await until(async () => ((await cursors.get(b))?.lastSeenSeq ?? 0) >= base + 2);
      await addSegments(["Golf four"]);
      await until(async () => ((await cursors.get(a))?.lastSeenSeq ?? 0) >= base + 3 && ((await cursors.get(b))?.lastSeenSeq ?? 0) >= base + 3);

      await (await runnerA.submit(a, id(), "followup", "only for a")).done;
      await ca.stop();
      await cb.stop();

      const outA = await content(a);
      const outB = await content(b);
      expect(outA.some((m) => m.includes("only for a"))).toBe(true);
      expect(outB.some((m) => m.includes("only for a"))).toBe(false);
      // a never ran out; b did, and only b got the notice
      expect(outA.some((m) => m.startsWith("system/notice"))).toBe(false);
      expect(outB.some((m) => m.startsWith("system/notice"))).toBe(true);
      expect((await terms.list(a)).length).toBeGreaterThanOrEqual((await terms.list(b)).length);
      expect((await terms.list(a)).map((t) => t.termNorm)).toContain("golf");
      expect((await terms.list(b)).map((t) => t.termNorm)).not.toContain("golf");
      expect((await budgets.get(a))!.tokensUsed).toBeGreaterThan((await budgets.get(b))!.tokensUsed);
      expect(await seqs(a)).toEqual((await seqs(a)).map((_, i) => i + 1));
      expect(await seqs(b)).toEqual((await seqs(b)).map((_, i) => i + 1));
    });

    test("a steer in one chat does not stop the other chat's turn", async () => {
      const a = await newChat("steer-a");
      const b = await newChat("steer-b");
      const runner = makeRunner(new StubChatAgent({ delayMs: 150 }));
      const slowB = runner.submit(b, id(), "followup", "slow b");
      const slowA = runner.submit(a, id(), "followup", "slow a");
      await new Promise((r) => setTimeout(r, 40));
      await runner.submit(a, id(), "steer", "urgent a");
      await Promise.all([(await slowB).done, (await slowA).done]);
      await runner.processInputs(a);
      expect((await content(b)).at(-1)).toBe("assistant/reply:re: slow b");
      expect((await content(a)).at(-1)).toBe("assistant/reply:re: urgent a");
    });
  });

  describe("concurrent writes", () => {
    test("many parallel submits, each sent twice, give one reply each, a gapless seq and exact charges", async () => {
      const chat = await newChat("concurrent-submit");
      const runner = makeRunner(new StubChatAgent());
      const ids = Array.from({ length: 20 }, id);
      const submits = ids.flatMap((messageId, i) => [
        runner.submit(chat, messageId, "followup", `q${i}`),
        runner.submit(chat, messageId, "followup", `q${i}`),
      ]);
      const results = await Promise.all(submits);
      expect(results.filter((r) => r.created)).toHaveLength(20);
      await Promise.all(results.map((r) => r.done));
      await runner.processInputs(chat);

      const all = await messages.tail(chat, 500);
      expect(all.filter((m) => m.role === "user")).toHaveLength(20);
      expect(all.filter((m) => m.role === "assistant")).toHaveLength(20);
      expect(all.map((m) => m.seq)).toEqual(all.map((_, i) => i + 1));
      expect((await budgets.get(chat))?.tokensUsed).toBe(20 * 120);
      expect(await inbox.pending(chat)).toHaveLength(0);
    });

    test("two server processes on one chat never answer a question twice or charge twice", async () => {
      const chat = await newChat("concurrent-processes");
      const one = makeRunner(new StubChatAgent({ delayMs: 15 }));
      const two = makeRunner(new StubChatAgent({ delayMs: 15 }));
      const sends: Promise<unknown>[] = [];
      for (let i = 0; i < 10; i++) {
        const runner = i % 2 ? one : two;
        sends.push(runner.submit(chat, id(), "followup", `m${i}`).then((s) => s.done));
      }
      await Promise.all(sends);
      await Promise.all([one.processInputs(chat), two.processInputs(chat)]);

      const all = await messages.tail(chat, 500);
      const users = all.filter((m) => m.role === "user");
      const replies = all.filter((m) => m.kind === "reply");
      expect(users).toHaveLength(10);
      // Two processes can promote messages in between each other's turns; a reply then
      // answers the newest question with the older ones as context. So there may be fewer
      // replies than questions, but never two answers to one question, and no question
      // is left without a reply after it.
      expect(replies.length).toBeGreaterThan(0);
      expect(replies.length).toBeLessThanOrEqual(10);
      expect(new Set(replies.map((m) => m.content)).size).toBe(replies.length);
      expect(all.at(-1)?.role).toBe("assistant");
      for (const user of users) expect(all.some((m) => m.role === "assistant" && m.seq > user.seq)).toBe(true);
      expect(all.map((m) => m.seq)).toEqual(all.map((_, i) => i + 1));
      expect((await budgets.get(chat))?.tokensUsed).toBe(replies.length * 120);
    });

    test("transcript turns and user turns interleave on one chat without losing either", async () => {
      const chat = await newChat("concurrent-mixed");
      const runner = makeRunner(new StubChatAgent({ delayMs: 5 }));
      const work: Promise<unknown>[] = [];
      for (let i = 1; i <= 6; i++) {
        work.push(runner.handleTranscript(chat, [segment(i, `Topic${i} Word`)]));
        work.push(runner.submit(chat, id(), "followup", `u${i}`).then((s) => s.done));
      }
      await Promise.all(work);
      await runner.processInputs(chat);

      const all = await messages.tail(chat, 500);
      expect(all.filter((m) => m.kind === "reply")).toHaveLength(6);
      expect(all.filter((m) => m.kind === "suggestion").length).toBeGreaterThan(0);
      expect(all.map((m) => m.seq)).toEqual(all.map((_, i) => i + 1));
      expect((await cursors.get(chat))?.lastSeenSeq).toBe(6);
      const charged = (await budgets.get(chat))!.tokensUsed;
      expect(charged).toBe(120 * (6 + 6));
      expect(errors).toEqual([]);
    });
  });
});
