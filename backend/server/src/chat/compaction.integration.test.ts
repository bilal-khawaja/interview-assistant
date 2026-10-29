import { testOwner } from "../auth/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createDb, type DbClient } from "../db/client";
import { ChatBudgetRepository } from "../db/repositories/chat-budget.repository";
import { ChatContextRepository } from "../db/repositories/chat-context.repository";
import { ChatMessageRepository } from "../db/repositories/chat-message.repository";
import { ChatSurfacedTermsRepository } from "../db/repositories/chat-surfaced-terms.repository";
import { ChatRepository, MeetingRepository } from "../db/repositories/meeting.repository";
import { chatMessages, meetings as meetingsTable } from "../db/schema";
import { env } from "../env";
import { ChatCompactor } from "./compaction";
import { ChatContextBuilder } from "./context";
import { KeyedCoordinator } from "./keyed-coordinator";
import { ChatRunner } from "./runner";
import { StubChatAgent, StubSummarizer } from "./stub-agent";

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
const CONFIG = { afterMessages: 6, afterTokens: 1_000_000, keepMessages: 4 };

run("ChatCompactor", () => {
  const db = client?.db as DbClient["db"];
  const messages = new ChatMessageRepository(db);
  const contexts = new ChatContextRepository(db);
  const builder = new ChatContextBuilder(db, { systemPrompt: "sys", historyLimit: 40, transcriptWindow: 5 });
  let meetingId: string;

  beforeAll(async () => {
    meetingId = (await new MeetingRepository(db).create("compaction test", await testOwner(db))).id;
  });

  afterAll(async () => {
    await db.delete(meetingsTable).where(eq(meetingsTable.id, meetingId));
    await client!.close();
  });

  /** A chat with `count` alternating user/assistant messages, ending on an assistant message. */
  async function seeded(count: number, tokenLimit = 1_000_000): Promise<string> {
    const chat = (await new ChatRepository(db).create(meetingId, "c")).id;
    await new ChatBudgetRepository(db).ensure(chat, tokenLimit);
    await builder.ensure(chat);
    for (let i = 1; i <= count; i++) {
      const user = i % 2 === 1;
      await messages.append(chat, {
        role: user ? "user" : "assistant",
        kind: user ? "followup" : "reply",
        content: `m${i}`,
      });
    }
    return chat;
  }

  test("folds old messages into a summary, starts a new epoch and charges the budget", async () => {
    const chat = await seeded(10);
    const summarizer = new StubSummarizer({ tokens: 50 });
    const compacted = await new ChatCompactor(db, summarizer, CONFIG).compactIfNeeded(chat);
    expect(compacted).toBe(true);

    const context = await contexts.get(chat);
    expect(context).toMatchObject({ epoch: 2, summaryUptoSeq: 6 });
    const summary = await messages.latestSummary(chat);
    expect(summary).toMatchObject({ seq: 11, role: "summary", kind: "summary" });
    expect((await new ChatBudgetRepository(db).get(chat))?.tokensUsed).toBe(60);
    // The prompt carries the fixed template and the folded messages only.
    expect(summarizer.prompts[0]).toContain("## Open questions");
    expect(summarizer.prompts[0]).toContain("m6");
    expect(summarizer.prompts[0]).not.toContain("m7");
  });

  test("history after compaction is the summary plus the messages it did not fold", async () => {
    const chat = await seeded(10);
    await new ChatCompactor(db, new StubSummarizer(), CONFIG).compactIfNeeded(chat);
    const built = await builder.build(chat, []);
    expect(built.history.map((m) => m.content)).toEqual([
      expect.stringContaining("summary 1"),
      "m7",
      "m8",
      "m9",
      "m10",
    ]);
    expect(built.epoch).toBe(2);
  });

  test("the frozen prompt is unchanged by compaction; surfaced terms survive", async () => {
    const chat = await seeded(10);
    await new ChatSurfacedTermsRepository(db).addMany(chat, [{ term: "Kafka", firstSeq: 1 }]);
    const before = await contexts.get(chat);
    await new ChatCompactor(db, new StubSummarizer(), CONFIG).compactIfNeeded(chat);
    const after = await contexts.get(chat);
    expect(after?.frozenPrompt).toBe(before?.frozenPrompt);
    expect(after?.promptHash).toBe(before?.promptHash);
    expect((await builder.build(chat, [])).surfacedTerms).toEqual(["Kafka"]);
  });

  test("does nothing below the threshold or when only the kept messages are live", async () => {
    const small = await seeded(5);
    const summarizer = new StubSummarizer();
    expect(await new ChatCompactor(db, summarizer, CONFIG).compactIfNeeded(small)).toBe(false);
    expect(await new ChatCompactor(db, summarizer, { ...CONFIG, afterMessages: 1 }).compactIfNeeded(await seeded(4))).toBe(false);
    expect(summarizer.prompts).toHaveLength(0);
    expect((await contexts.get(small))?.epoch).toBe(1);
  });

  test("an estimated token count over the limit also triggers it", async () => {
    const chat = await seeded(6);
    const compactor = new ChatCompactor(db, new StubSummarizer(), { ...CONFIG, afterMessages: 1000, afterTokens: 1 });
    expect(await compactor.compactIfNeeded(chat)).toBe(true);
  });

  test("leaves an unanswered user message as the newest message", async () => {
    const chat = await seeded(11);
    expect((await messages.tail(chat, 1))[0]?.role).toBe("user");
    const summarizer = new StubSummarizer();
    expect(await new ChatCompactor(db, summarizer, CONFIG).compactIfNeeded(chat)).toBe(false);
    expect(summarizer.prompts).toHaveLength(0);
  });

  test("skips when the budget is spent", async () => {
    const chat = await seeded(10, 100);
    await new ChatBudgetRepository(db).charge(chat, 100);
    expect(await new ChatCompactor(db, new StubSummarizer(), CONFIG).compactIfNeeded(chat)).toBe(false);
  });

  test("a failing summarizer changes nothing", async () => {
    const chat = await seeded(10);
    const compactor = new ChatCompactor(db, new StubSummarizer({ fail: true }), CONFIG);
    await expect(compactor.compactIfNeeded(chat)).rejects.toThrow("summarizer down");
    expect(await contexts.get(chat)).toMatchObject({ epoch: 1, summaryUptoSeq: 0 });
    expect(await messages.latestSummary(chat)).toBeNull();
    expect((await new ChatBudgetRepository(db).get(chat))?.tokensUsed).toBe(0);
  });

  test("two compactions racing on one chat start one epoch and write one summary", async () => {
    const chat = await seeded(10);
    const results = await Promise.all([
      new ChatCompactor(db, new StubSummarizer(), CONFIG).compactIfNeeded(chat),
      new ChatCompactor(db, new StubSummarizer(), CONFIG).compactIfNeeded(chat),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await contexts.get(chat))?.epoch).toBe(2);
    expect((await messages.tail(chat, 50)).filter((m) => m.role === "summary")).toHaveLength(1);
    expect((await new ChatBudgetRepository(db).get(chat))?.tokensUsed).toBe(60);
  });

  test("a second compaction folds the previous summary in and keeps seq gapless", async () => {
    const chat = await seeded(10);
    const summarizer = new StubSummarizer();
    const compactor = new ChatCompactor(db, summarizer, CONFIG);
    await compactor.compactIfNeeded(chat);
    for (let i = 11; i <= 20; i++) {
      await messages.append(chat, {
        role: i % 2 === 1 ? "user" : "assistant",
        kind: i % 2 === 1 ? "followup" : "reply",
        content: `m${i}`,
      });
    }
    expect(await compactor.compactIfNeeded(chat)).toBe(true);
    expect(summarizer.prompts[1]).toContain("Previous summary");
    expect(summarizer.prompts[1]).toContain("summary 1");
    expect((await contexts.get(chat))?.epoch).toBe(3);
    const all = await messages.tail(chat, 100);
    expect(all.map((m) => m.seq)).toEqual(all.map((_, i) => i + 1));
    const built = await builder.build(chat, []);
    expect(built.history.filter((m) => m.role === "summary")).toHaveLength(1);
    expect(built.history[0]?.content).toContain("summary 2");
  });

  test("the runner compacts after a turn and the next turn sees the summary", async () => {
    const chat = (await new ChatRepository(db).create(meetingId, "runner")).id;
    const agent = new StubChatAgent();
    const summarizer = new StubSummarizer();
    const errors: unknown[] = [];
    const runner = new ChatRunner({
      db,
      coordinator: new KeyedCoordinator(),
      agent,
      summarizer,
      compaction: { afterMessages: 6, afterTokens: 1_000_000, keepMessages: 2 },
      onError: (e) => errors.push(e),
    });
    for (let i = 0; i < 4; i++) {
      const { done } = await runner.submit(chat, id(), "followup", `q${i}`);
      await done;
    }
    expect(errors).toEqual([]);
    expect(summarizer.prompts.length).toBeGreaterThan(0);
    expect((await contexts.get(chat))?.epoch).toBeGreaterThan(1);
    const last = agent.calls.at(-1)!;
    expect(last.history[0]?.role).toBe("summary");
    expect(last.history.at(-1)?.content).toContain("q");
  });

  test("a runner whose summarizer fails still answers and reports the error", async () => {
    const chat = (await new ChatRepository(db).create(meetingId, "runner-fail")).id;
    const errors: unknown[] = [];
    const runner = new ChatRunner({
      db,
      coordinator: new KeyedCoordinator(),
      agent: new StubChatAgent(),
      summarizer: new StubSummarizer({ fail: true }),
      compaction: { afterMessages: 4, afterTokens: 1_000_000, keepMessages: 2 },
      onError: (e) => errors.push(e),
    });
    for (let i = 0; i < 4; i++) {
      const { done } = await runner.submit(chat, id(), "followup", `q${i}`);
      await done;
    }
    const all = await messages.tail(chat, 50);
    expect(all.filter((m) => m.role === "assistant")).toHaveLength(4);
    expect(errors.length).toBeGreaterThan(0);
  });
});
