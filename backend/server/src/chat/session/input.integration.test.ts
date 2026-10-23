import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { env } from "../../env";
import { createDb, type DbClient } from "../../db/client";
import { ChatInboxRepository } from "../../db/repositories/chat-inbox.repository";
import { ChatMessageRepository } from "../../db/repositories/chat-message.repository";
import { ChatRepository, MeetingRepository } from "../../db/repositories/meeting.repository";
import { chatMessages, meetings as meetingsTable } from "../../db/schema";
import { KeyedCoordinator } from "../keyed-coordinator";
import { ChatInput } from "./input";

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

run("ChatInput", () => {
  const db = client?.db as DbClient["db"];
  const messages = new ChatMessageRepository(db);
  const inbox = new ChatInboxRepository(db);
  let meetingId: string;
  const steered: string[] = [];
  const errors: unknown[] = [];
  const coordinator = new KeyedCoordinator();
  const input = new ChatInput({
    db,
    coordinator,
    onSteer: (chatId) => steered.push(chatId),
    onError: (e) => errors.push(e),
  });
  const newChat = async (title: string) => (await new ChatRepository(db).create(meetingId, title)).id;

  beforeAll(async () => {
    meetingId = (await new MeetingRepository(db).create("chat input test")).id;
  });

  afterAll(async () => {
    await db.delete(meetingsTable).where(eq(meetingsTable.id, meetingId));
    await client!.close();
  });

  test("submit promotes the input into history with the inbox id and mode as kind", async () => {
    const chat = await newChat("basic");
    const messageId = id();
    const { created, promoted } = await input.submit(chat, messageId, "followup", "hello");
    expect(created).toBe(true);
    const [message] = await promoted;
    expect(message).toMatchObject({ id: messageId, role: "user", kind: "followup", content: "hello", seq: 1 });
    expect(await inbox.pending(chat)).toHaveLength(0);
  });

  test("resubmitting the same id does not duplicate the message", async () => {
    const chat = await newChat("idempotent");
    const messageId = id();
    await (await input.submit(chat, messageId, "followup", "once")).promoted;
    const again = await input.submit(chat, messageId, "followup", "once, edited");
    await again.promoted;
    expect(again.created).toBe(false);
    const history = await messages.tail(chat, 10);
    expect(history).toHaveLength(1);
    expect(history[0]!.content).toBe("once");
  });

  test("steers are promoted before follow-ups admitted earlier", async () => {
    const chat = await newChat("order");
    const gate = coordinator.run(chat, () => sleep(60));
    const results = [
      await input.admit(chat, id(), "followup", "f1"),
      await input.admit(chat, id(), "steer", "s1"),
      await input.admit(chat, id(), "followup", "f2"),
      await input.admit(chat, id(), "steer", "s2"),
    ];
    const promoted = await input.drain(chat);
    await gate;
    expect(promoted.map((m) => m.content)).toEqual(["s1", "s2", "f1", "f2"]);
    expect((await messages.tail(chat, 10)).map((m) => m.content)).toEqual(["s1", "s2", "f1", "f2"]);
    expect(results.every((r) => r.created)).toBe(true);
  });

  test("promotion waits for the chat's running turn", async () => {
    const chat = await newChat("waits");
    let turnDone = false;
    const turn = coordinator.run(chat, async () => {
      await sleep(80);
      turnDone = true;
    });
    const { promoted } = await input.submit(chat, id(), "followup", "later");
    await sleep(20);
    expect(turnDone).toBe(false);
    expect(await messages.head(chat)).toBe(0);
    await Promise.all([turn, promoted]);
    expect(turnDone).toBe(true);
    expect(await messages.head(chat)).toBe(1);
  });

  test("a new steer notifies onSteer; follow-ups and repeats do not", async () => {
    const chat = await newChat("steer-signal");
    const before = steered.length;
    const steerId = id();
    await input.admit(chat, steerId, "steer", "stop");
    await input.admit(chat, steerId, "steer", "stop");
    await input.admit(chat, id(), "followup", "later");
    expect(steered.slice(before)).toEqual([chat]);
  });

  test("recover promotes inputs left admitted by a crash, across chats", async () => {
    const c1 = await newChat("recover-1");
    const c2 = await newChat("recover-2");
    const m1 = id();
    const m2 = id();
    await inbox.admit(c1, m1, "followup", "left behind 1");
    await inbox.admit(c2, m2, "steer", "left behind 2");
    const recovered = await input.recover();
    // Also sweeps up inputs earlier tests admitted without draining.
    expect(recovered.map((m) => m.id)).toEqual(expect.arrayContaining([m1, m2]));
    expect(await inbox.pending(c1)).toHaveLength(0);
    expect(await inbox.pending(c2)).toHaveLength(0);
  });

  test("recovery after a crash between append and promote does not duplicate", async () => {
    const chat = await newChat("half-done");
    const messageId = id();
    await inbox.admit(chat, messageId, "followup", "half");
    await messages.append(chat, { id: messageId, role: "user", kind: "followup", content: "half" });
    const promoted = await input.drain(chat);
    expect(promoted).toHaveLength(1);
    expect(await messages.head(chat)).toBe(1);
    expect(await inbox.pending(chat)).toHaveLength(0);
  });

  test("chats do not see each other's inputs", async () => {
    const a = await newChat("iso-a");
    const b = await newChat("iso-b");
    await Promise.all([
      (await input.submit(a, id(), "followup", "for a")).promoted,
      (await input.submit(b, id(), "followup", "for b")).promoted,
    ]);
    expect((await messages.tail(a, 10)).map((m) => m.content)).toEqual(["for a"]);
    expect((await messages.tail(b, 10)).map((m) => m.content)).toEqual(["for b"]);
    expect(errors).toHaveLength(0);
  });
});
