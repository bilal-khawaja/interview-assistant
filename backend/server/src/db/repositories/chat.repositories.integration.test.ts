import { testOwner } from "../../auth/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { env } from "../../env";
import { createDb, type DbClient } from "../client";
import { chatMessages, chats, meetings as meetingsTable } from "../schema";
import { ChatBudgetRepository } from "./chat-budget.repository";
import { ChatContextRepository } from "./chat-context.repository";
import { ChatInboxRepository, InboxIdConflictError } from "./chat-inbox.repository";
import { ChatMessageRepository } from "./chat-message.repository";
import { ChatSurfacedTermsRepository, normalizeTerm } from "./chat-surfaced-terms.repository";
import { ChatRepository, MeetingRepository } from "./meeting.repository";

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

run("chat repositories", () => {
  const db = client?.db as DbClient["db"];
  const messages = new ChatMessageRepository(db);
  const inbox = new ChatInboxRepository(db);
  const terms = new ChatSurfacedTermsRepository(db);
  const budget = new ChatBudgetRepository(db);
  const context = new ChatContextRepository(db);
  let meetingId: string;
  let a: string;
  let b: string;

  beforeAll(async () => {
    meetingId = (await new MeetingRepository(db).create("chat repo test", await testOwner(db))).id;
    const chatRepo = new ChatRepository(db);
    a = (await chatRepo.create(meetingId, "a")).id;
    b = (await chatRepo.create(meetingId, "b")).id;
  });

  afterAll(async () => {
    await db.delete(meetingsTable).where(eq(meetingsTable.id, meetingId));
    await client!.close();
  });

  test("normalizeTerm ignores case and whitespace", () => {
    expect(normalizeTerm("  Vector   DB ")).toBe("vector db");
  });

  test("append allocates contiguous seq per chat, independent across chats", async () => {
    const first = await messages.append(a, { role: "user", kind: "followup", content: "one" });
    const other = await messages.append(b, { role: "user", kind: "followup", content: "other" });
    const second = await messages.append(a, { role: "assistant", kind: "reply", content: "two" });
    expect([first.seq, second.seq]).toEqual([1, 2]);
    expect(other.seq).toBe(1);
    expect(await messages.head(a)).toBe(2);
  });

  test("append with the same id writes once", async () => {
    const id = crypto.randomUUID();
    const one = await messages.append(a, { id, role: "user", kind: "steer", content: "x" });
    const two = await messages.append(a, { id, role: "user", kind: "steer", content: "CHANGED" });
    expect(two.seq).toBe(one.seq);
    expect(two.content).toBe("x");
  });

  test("concurrent appends to one chat get distinct contiguous seqs", async () => {
    const before = await messages.head(b);
    const rows = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        messages.append(b, { role: "assistant", kind: "suggestion", content: `s${i}` }),
      ),
    );
    const seqs = rows.map((r) => r.seq).sort((x, y) => x - y);
    expect(seqs).toEqual(Array.from({ length: 10 }, (_, i) => before + 1 + i));
  });

  test("listAfter and tail read in seq order", async () => {
    const after = await messages.listAfter(a, 1, 10);
    expect(after.map((m) => m.seq)).toEqual([...after.map((m) => m.seq)].sort((x, y) => x - y));
    expect(after.every((m) => m.seq > 1)).toBe(true);
    const tail = await messages.tail(a, 2);
    expect(tail.map((m) => m.seq)).toEqual([(await messages.head(a)) - 1, await messages.head(a)]);
  });

  test("inbox admit is idempotent and promote happens once", async () => {
    const id = crypto.randomUUID();
    const first = await inbox.admit(a, id, "followup", "hello");
    const again = await inbox.admit(a, id, "followup", "hello again");
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.item.text).toBe("hello");
    await expect(inbox.admit(b, id, "followup", "x")).rejects.toBeInstanceOf(InboxIdConflictError);

    expect((await inbox.pending(a)).map((i) => i.messageId)).toContain(id);
    expect(await inbox.promote(a, id)).not.toBeNull();
    expect(await inbox.promote(a, id)).toBeNull();
    expect((await inbox.pending(a)).map((i) => i.messageId)).not.toContain(id);
  });

  test("surfaced terms dedupe within a chat and stay separate across chats", async () => {
    const added = await terms.addMany(a, [
      { term: "pgvector", firstSeq: 3 },
      { term: " PGVector ", firstSeq: 4 },
      { term: "HNSW", firstSeq: 5 },
    ]);
    expect(added.map((t) => t.termNorm).sort()).toEqual(["hnsw", "pgvector"]);
    expect(await terms.addMany(a, [{ term: "pgvector", firstSeq: 9 }])).toHaveLength(0);
    expect(await terms.unseen(a, [{ term: "HNSW", firstSeq: 1 }, { term: "ivfflat", firstSeq: 1 }]))
      .toEqual([{ term: "ivfflat", firstSeq: 1 }]);
    expect(await terms.unseen(b, [{ term: "pgvector", firstSeq: 1 }])).toHaveLength(1);
  });

  test("budget charges are atomic under concurrency", async () => {
    await budget.ensure(a, 1000);
    await Promise.all(Array.from({ length: 20 }, () => budget.charge(a, 10, 5)));
    const row = await budget.get(a);
    expect(row?.tokensUsed).toBe(200);
    expect(row?.costMicros).toBe(100);
    expect(await budget.remaining(a)).toBe(800);
    expect((await budget.ensure(a, 5)).tokenLimit).toBe(1000);
  });

  test("context epochs advance and keep the frozen prompt stable between them", async () => {
    const init = await context.ensure(a, { frozenPrompt: "p1", promptHash: "h1" });
    expect(init.epoch).toBe(1);
    expect((await context.ensure(a, { frozenPrompt: "other", promptHash: "h" })).frozenPrompt).toBe("p1");
    const next = await context.startEpoch(a, { frozenPrompt: "p2", promptHash: "h2", summaryUptoSeq: 7 });
    expect([next.epoch, next.frozenPrompt, next.summaryUptoSeq]).toEqual([2, "p2", 7]);
  });

  test("deleting a chat removes all its rows", async () => {
    const temp = (await new ChatRepository(db).create(meetingId, "temp")).id;
    await messages.append(temp, { role: "user", kind: "followup", content: "bye" });
    await terms.addMany(temp, [{ term: "gone", firstSeq: 1 }]);
    await budget.ensure(temp, 10);
    await db.delete(chats).where(eq(chats.id, temp));
    expect(await messages.head(temp)).toBe(0);
    expect(await terms.list(temp)).toHaveLength(0);
    expect(await budget.get(temp)).toBeNull();
  });
});
