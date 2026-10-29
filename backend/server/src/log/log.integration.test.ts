import { testOwner } from "../auth/testing";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { env } from "../env";
import { createDb, type DbClient } from "../db/client";
import {
  meetingParticipants,
  meetings as meetingsTable,
  transcriptSegments,
} from "../db/schema";
import { CursorRepository } from "../db/repositories/cursor.repository";
import {
  ChatRepository,
  MeetingRepository,
} from "../db/repositories/meeting.repository";
import {
  MeetingParticipantRepository,
  PersonRepository,
} from "../db/repositories/participant.repository";
import { SegmentRepository } from "../db/repositories/segment.repository";
import { SegmentAppender } from "./append";
import { consume } from "./consume";
import { TranscriptConsumer, type Delivery } from "./consumer";
import { CursorService } from "./cursor";
import {
  isConstraintViolation,
  NotFoundError,
  ProducerAlreadyActiveError,
} from "./errors";
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
async function until(cond: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(10);
  }
  throw new Error("timed out waiting for condition");
}

run("transcript log (postgres)", () => {
  const { db, sql } = client ?? ({} as DbClient);
  const meetings = new MeetingRepository(db);
  const chats = new ChatRepository(db);
  const people = new PersonRepository(db);
  const participants = new MeetingParticipantRepository(db);
  const cursorRepo = new CursorRepository(db);
  const segments = new SegmentRepository(db);
  const cursors = new CursorService({ chats, cursors: cursorRepo, segments });
  const hub = new WakeHub();
  const bridge = new PgWakeBridge(sql, hub);
  const created: string[] = [];

  const newMeeting = async () => {
    const m = await meetings.create("t", await testOwner(db));
    created.push(m.id);
    return m;
  };
  const open = (meetingId: string) =>
    SegmentAppender.open({ sql, segments, retryBaseMs: 5 }, meetingId);
  const readAfter = (m: string, a: number, l: number) => segments.readAfter(m, a, l);
  const draft = (i: number) => ({ text: `seg ${i}`, startMs: i * 1000, endMs: i * 1000 + 900 });

  beforeAll(() => bridge.start());
  afterAll(async () => {
    await bridge.stop();
    if (created.length) await meetings.deleteWhere(inArray(meetingsTable.id, created));
    await client?.close();
  });

  test("appending the same seq twice yields one row (idempotent)", async () => {
    const m = await newMeeting();
    const a = await open(m.id);
    const row = await a.append(draft(1));
    const again = await segments.appendIgnore([
      { meetingId: m.id, seq: row.seq, text: row.text, startMs: row.startMs, endMs: row.endMs },
    ]);
    expect(again).toEqual([]);
    expect((await segments.readAfter(m.id, 0, 10)).length).toBe(1);
    await a.close();
  });

  test("concurrent appends are serialized: gapless, ordered, never visible out of order", async () => {
    const m = await newMeeting();
    const a = await open(m.id);

    let sawHole = false;
    let stop = false;
    const watcher = (async () => {
      while (!stop) {
        const rows = await segments.readAfter(m.id, 0, 1000);
        if (rows.some((r, i) => r.seq !== i + 1)) sawHole = true;
        await sleep(2);
      }
    })();

    await Promise.all(Array.from({ length: 60 }, (_, i) => a.append(draft(i))));
    stop = true;
    await watcher;

    const rows = await segments.readAfter(m.id, 0, 1000);
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(sawHole).toBe(false);
    await a.close();
  });

  test("a second producer for the same meeting is rejected; lock frees on close", async () => {
    const m = await newMeeting();
    const a = await open(m.id);
    await expect(open(m.id)).rejects.toBeInstanceOf(ProducerAlreadyActiveError);
    await a.close();
    const b = await open(m.id);
    await b.close();
  });

  test("restart resumes seq from the committed head", async () => {
    const m = await newMeeting();
    const a = await open(m.id);
    await a.append(draft(1));
    await a.append(draft(2));
    await a.close();
    const b = await open(m.id);
    expect((await b.append(draft(3))).seq).toBe(3);
    await b.close();
  });

  test("UPDATE is rejected; the log is append-only", async () => {
    const m = await newMeeting();
    const a = await open(m.id);
    const first = await a.append(draft(1));
    const rejected = await db
      .update(transcriptSegments)
      .set({ text: "x" })
      .where(eq(transcriptSegments.id, first.id))
      .then(
        () => false,
        (error: unknown) => isConstraintViolation(error),
      );
    expect(rejected).toBe(true);
    expect((await a.append(draft(1))).seq).toBe(2);
    await a.close();
  });

  test("speakers resolve to people at read time; relabeling never rewrites the log", async () => {
    const m = await newMeeting();
    const email = `cand-${crypto.randomUUID()}@example.com`;
    const candidate = await people.upsertByEmail({
      fullName: "Ada Lovelace",
      email: email.toUpperCase(),
      organization: "Analytical Engines",
    });
    const again = await people.upsertByEmail({ fullName: "Ada L.", email, jobTitle: "Engineer" });
    expect(again.id).toBe(candidate.id);
    expect(again.organization).toBe("Analytical Engines");
    expect(again.jobTitle).toBe("Engineer");

    const interviewer = await people.create({ fullName: "Grace Hopper", email: null });
    await participants.add({ meetingId: m.id, personId: candidate.id, role: "candidate", label: "Candidate", speakerKey: "spk_0" });
    const grace = await participants.add({ meetingId: m.id, personId: interviewer.id, role: "interviewer", label: "Interviewer" });

    const a = await open(m.id);
    await a.append({ ...draft(1), speakerKey: "spk_0" });
    await a.append({ ...draft(2), speakerKey: "spk_1" });
    await a.append({ ...draft(3) });

    let resolved = await segments.readAfterResolved(m.id, 0, 10);
    expect(resolved.map((r) => r.person?.fullName ?? null)).toEqual(["Ada L.", null, null]);
    expect(resolved[0]!.participant?.role).toBe("candidate");

    await participants.bindSpeaker(m.id, grace.id, "spk_1");
    resolved = await segments.readAfterResolved(m.id, 0, 10);
    expect(resolved.map((r) => r.person?.fullName ?? null)).toEqual(["Ada L.", "Grace Hopper", null]);
    expect((await participants.findBySpeakerKey(m.id, "spk_1"))?.label).toBe("Interviewer");
    expect((await participants.listForMeeting(m.id)).length).toBe(2);
    await a.close();
  });

  test("CHECK constraints reject unknown role and meeting status", async () => {
    const m = await newMeeting();
    const person = await people.create({ fullName: "Bad Role", email: null });
    const badRole = await db
      .insert(meetingParticipants)
      .values({ meetingId: m.id, personId: person.id, role: "ceo" as never })
      .then(() => false, isConstraintViolation);
    const badStatus = await meetings
      .updateWhere(eq(meetingsTable.id, m.id), { status: "paused" as never })
      .then(() => false, isConstraintViolation);
    expect(badRole).toBe(true);
    expect(badStatus).toBe(true);
  });

  test("zero attached chats still persists segments", async () => {
    const m = await newMeeting();
    const a = await open(m.id);
    await a.append(draft(1));
    expect(await segments.head(m.id)).toBe(1);
    await a.close();
  });

  test("NOTIFY wakes a consumer without any in-process hand-off", async () => {
    const m = await newMeeting();
    const a = await open(m.id);
    const ac = new AbortController();
    const it = consume({ hub, readAfter, pollMs: 60_000 }, m.id, 0, ac.signal);
    const next = it.next();
    await sleep(50);
    await a.append(draft(1));
    const batch = await next;
    expect(batch.value?.map((r) => r.seq)).toEqual([1]);
    ac.abort();
    await it.next();
    await a.close();
  });

  test("reconnect with a cursor receives exactly the missed rows", async () => {
    const m = await newMeeting();
    const a = await open(m.id);
    for (let i = 1; i <= 5; i++) await a.append(draft(i));
    const ac = new AbortController();
    const it = consume({ hub, readAfter, pollMs: 60_000 }, m.id, 3, ac.signal);
    expect((await it.next()).value?.map((r) => r.seq)).toEqual([4, 5]);
    ac.abort();
    await it.next();
    await a.close();
  });

  test("two chats on one meeting keep independent cursors; late chat starts at its own", async () => {
    const m = await newMeeting();
    const c1 = await chats.create(m.id);
    const c2 = await chats.create(m.id);
    const a = await open(m.id);
    for (let i = 1; i <= 6; i++) await a.append(draft(i));

    expect(await cursors.attach(m.id, c1.id)).toBe(0);
    await cursors.commit(m.id, c1.id, 4);
    expect(await cursors.attach(m.id, c2.id, { kind: "tail", tail: 2 })).toBe(4);
    expect(await cursors.position(m.id, c1.id)).toBe(4);
    expect(await cursors.commit(m.id, c1.id, 2)).toBe(4);
    await a.close();
  });

  test("a chat from another meeting is indistinguishable from a missing one", async () => {
    const m1 = await newMeeting();
    const m2 = await newMeeting();
    const foreign = await chats.create(m2.id);
    const err = (p: Promise<unknown>) => p.then(() => new Error("resolved"), (e: Error) => e);
    const a = await err(cursors.attach(m1.id, foreign.id));
    const b = await err(cursors.attach(m1.id, crypto.randomUUID()));
    expect(a).toBeInstanceOf(NotFoundError);
    expect(b).toBeInstanceOf(NotFoundError);
    expect(a.message).toBe(b.message);
  });

  test("at-least-once: a failing handler is retried and the cursor only moves after success", async () => {
    const m = await newMeeting();
    const chat = await chats.create(m.id);
    const a = await open(m.id);
    for (let i = 1; i <= 3; i++) await a.append(draft(i));

    const consumer = new TranscriptConsumer({ hub, readAfter, sql, cursors, pollMs: 60_000 });
    const ac = new AbortController();
    const seen: Delivery[] = [];
    let failedOnce = false;

    const done = consumer.run({
      meetingId: m.id,
      chatId: chat.id,
      signal: ac.signal,
      retryBaseMs: 5,
      handler: async (d) => {
        seen.push(d);
        if (!failedOnce) {
          failedOnce = true;
          expect(await cursors.position(m.id, chat.id)).toBe(0);
          throw new Error("boom");
        }
      },
    });

    await until(async () => (await cursors.position(m.id, chat.id)) === 3);
    expect(seen.length).toBe(2);
    expect(seen[1]!.attempt).toBe(2);
    expect(seen.every((d) => d.segments.map((s) => s.seq).join() === "1,2,3")).toBe(true);
    ac.abort();
    await done;
    await a.close();
  });

  test("at-least-once: a crash before commit redelivers on the next run", async () => {
    const m = await newMeeting();
    const chat = await chats.create(m.id);
    const a = await open(m.id);
    for (let i = 1; i <= 3; i++) await a.append(draft(i));
    const consumer = new TranscriptConsumer({ hub, readAfter, sql, cursors, pollMs: 60_000 });

    const ac1 = new AbortController();
    const first = consumer.run({
      meetingId: m.id,
      chatId: chat.id,
      signal: ac1.signal,
      handler: async () => {
        ac1.abort();
        throw new Error("process died");
      },
    });
    await first;
    expect(await cursors.position(m.id, chat.id)).toBe(0);

    const ac2 = new AbortController();
    const got: number[] = [];
    const second = consumer.run({
      meetingId: m.id,
      chatId: chat.id,
      signal: ac2.signal,
      handler: async (d) => void got.push(...d.segments.map((s) => s.seq)),
    });
    await until(() => got.length >= 3);
    expect(got).toEqual([1, 2, 3]);
    ac2.abort();
    await second;
    await a.close();
  });

  test("only one runner per chat; many chats consume one meeting at once", async () => {
    const m = await newMeeting();
    const c1 = await chats.create(m.id);
    const c2 = await chats.create(m.id);
    const a = await open(m.id);
    const consumer = new TranscriptConsumer({ hub, readAfter, sql, cursors, pollMs: 60_000 });
    const ac = new AbortController();
    const got = { [c1.id]: [] as number[], [c2.id]: [] as number[] };
    const start = (chatId: string) =>
      consumer.run({
        meetingId: m.id,
        chatId,
        signal: ac.signal,
        handler: async (d) => void got[chatId]!.push(...d.segments.map((s) => s.seq)),
      });

    const r1 = start(c1.id);
    const r2 = start(c2.id);
    await sleep(100);
    await expect(start(c1.id)).rejects.toThrow(/already running/);

    for (let i = 1; i <= 4; i++) await a.append(draft(i));
    await until(() => got[c1.id]!.length >= 4 && got[c2.id]!.length >= 4);
    expect(got[c1.id]).toEqual([1, 2, 3, 4]);
    expect(got[c2.id]).toEqual([1, 2, 3, 4]);
    ac.abort();
    await Promise.all([r1, r2]);
    await a.close();
  });
});
