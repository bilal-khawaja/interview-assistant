import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { env } from "../env";
import { createDb, type DbClient } from "../db/client";
import { CursorRepository } from "../db/repositories/cursor.repository";
import {
  ChatRepository,
  MeetingRepository,
} from "../db/repositories/meeting.repository";
import { SegmentRepository } from "../db/repositories/segment.repository";
import { meetings as meetingsTable, transcriptSegments } from "../db/schema";
import { SegmentAppender } from "./append";
import { TranscriptConsumer } from "./consumer";
import { CursorService } from "./cursor";
import { dedupeHandler } from "./dedupe";
import { PgWakeBridge, WakeHub } from "./wake";

const url = env.DATABASE_URL;

async function probe(): Promise<DbClient | null> {
  if (!url) return null;
  try {
    const client = createDb(url);
    await client.db.select().from(transcriptSegments).limit(0);
    return client;
  } catch {
    return null;
  }
}

const client = await probe();
const run = client ? describe : describe.skip;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(10);
  }
  throw new Error("timed out waiting for condition");
}

function seeded(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

run("at-least-once delivery and dedupe (postgres)", () => {
  const { db, sql } = client ?? ({} as DbClient);
  const meetings = new MeetingRepository(db);
  const chats = new ChatRepository(db);
  const segments = new SegmentRepository(db);
  const cursorRepo = new CursorRepository(db);
  const hub = new WakeHub();
  const bridge = new PgWakeBridge(sql, hub);
  const created: string[] = [];

  const readAfter = (m: string, a: number, l: number) => segments.readAfter(m, a, l);
  const draft = (i: number) => ({ text: `seg ${i}`, startMs: i * 1000, endMs: i * 1000 + 900 });

  class FlakyCursors extends CursorService {
    commitCalls = 0;
    constructor(private readonly shouldFail: (call: number) => boolean) {
      super({ chats, cursors: cursorRepo, segments });
    }
    override async commit(meetingId: string, chatId: string, seq: number) {
      const call = this.commitCalls++;
      if (this.shouldFail(call)) throw new Error("commit failed");
      return super.commit(meetingId, chatId, seq);
    }
  }

  const setup = async () => {
    const meeting = await meetings.create("delivery");
    created.push(meeting.id);
    const chat = await chats.create(meeting.id);
    const appender = await SegmentAppender.open({ sql, segments, retryBaseMs: 5 }, meeting.id);
    return { meeting, chat, appender };
  };

  beforeAll(() => bridge.start());
  afterAll(async () => {
    await bridge.stop();
    if (created.length) await meetings.deleteWhere(inArray(meetingsTable.id, created));
    await client?.close();
  });

  test("no segment is ever lost under random handler failures, commit failures and restarts", async () => {
    const total = 120;
    const { meeting, chat, appender } = await setup();
    const rand = seeded(42);
    const cursors = new FlakyCursors(() => rand() < 0.25);
    const consumer = new TranscriptConsumer({ hub, readAfter, sql, cursors, pollMs: 50, batchSize: 7 });

    const deliveries: number[] = [];
    let handlerFailures = 0;
    const handler = async (d: { segments: { seq: number }[] }) => {
      for (const s of d.segments) deliveries.push(s.seq);
      if (rand() < 0.3) {
        handlerFailures++;
        throw new Error("handler failed");
      }
    };

    const producing = (async () => {
      for (let i = 1; i <= total; i++) {
        await appender.append(draft(i));
        if (i % 10 === 0) await sleep(5);
      }
    })();

    const committed = async () => {
      const row = await cursorRepo.get(chat.id);
      return row?.lastSeenSeq ?? 0;
    };

    let restarts = 0;
    while ((await committed()) < total) {
      const ac = new AbortController();
      const running = consumer.run({
        meetingId: meeting.id,
        chatId: chat.id,
        signal: ac.signal,
        handler,
        retryBaseMs: 2,
        retryMaxMs: 10,
      });
      await sleep(30 + Math.floor(rand() * 60));
      ac.abort();
      await running;
      restarts++;
      if (restarts > 200) throw new Error("did not converge");
    }
    await producing;

    const unique = new Set(deliveries);
    for (let seq = 1; seq <= total; seq++) expect(unique.has(seq)).toBe(true);
    expect(await committed()).toBe(total);
    expect(handlerFailures).toBeGreaterThan(0);
    expect(deliveries.length).toBeGreaterThan(total);
    await appender.close();
  });

  test("a failed commit redelivers the batch; dedupeHandler makes the effect happen exactly once", async () => {
    const { meeting, chat, appender } = await setup();
    for (let i = 1; i <= 5; i++) await appender.append(draft(i));

    const cursors = new FlakyCursors((call) => call < 3);
    const consumer = new TranscriptConsumer({ hub, readAfter, sql, cursors, pollMs: 50 });

    const received: number[] = [];
    const effects: number[] = [];
    const inner = dedupeHandler(async (d) => void effects.push(...d.segments.map((s) => s.seq)));
    const handler = async (d: Parameters<typeof inner>[0]) => {
      received.push(...d.segments.map((s) => s.seq));
      await inner(d);
    };

    const ac = new AbortController();
    const running = consumer.run({
      meetingId: meeting.id,
      chatId: chat.id,
      signal: ac.signal,
      handler,
      retryBaseMs: 2,
      retryMaxMs: 5,
    });
    await until(async () => ((await cursorRepo.get(chat.id))?.lastSeenSeq ?? 0) === 5);
    ac.abort();
    await running;

    expect(received).toEqual([1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 1, 2, 3, 4, 5]);
    expect(effects).toEqual([1, 2, 3, 4, 5]);
    await appender.close();
  });

  test("without dedupe the same redelivery applies the effect repeatedly", async () => {
    const { meeting, chat, appender } = await setup();
    for (let i = 1; i <= 3; i++) await appender.append(draft(i));

    const cursors = new FlakyCursors((call) => call < 1);
    const consumer = new TranscriptConsumer({ hub, readAfter, sql, cursors, pollMs: 50 });
    const effects: number[] = [];
    const ac = new AbortController();
    const running = consumer.run({
      meetingId: meeting.id,
      chatId: chat.id,
      signal: ac.signal,
      handler: async (d) => void effects.push(...d.segments.map((s) => s.seq)),
      retryBaseMs: 2,
    });
    await until(async () => ((await cursorRepo.get(chat.id))?.lastSeenSeq ?? 0) === 3);
    ac.abort();
    await running;

    expect(effects).toEqual([1, 2, 3, 1, 2, 3]);
    await appender.close();
  });
});
