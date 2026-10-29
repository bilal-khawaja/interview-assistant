import { testOwner } from "../auth/testing";
import { sql as rawSql, inArray } from "drizzle-orm";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../env";
import { createDb, type DbClient } from "../db/client";
import { tryAdvisoryLock } from "../db/locks";
import { MeetingRepository } from "../db/repositories/meeting.repository";
import { SegmentRepository } from "../db/repositories/segment.repository";
import { meetings as meetingsTable, transcriptSegments } from "../db/schema";
import { PRODUCER_LOCK, SegmentAppender } from "./append";
import { ProducerAlreadyActiveError, ProducerLockLostError } from "./errors";
import { SegmentSpool } from "./spool";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(20);
  }
  throw new Error("timed out waiting for condition");
}

run("write-ahead spool and pre-write lock probe (postgres)", () => {
  const { db, sql } = client ?? ({} as DbClient);
  const meetings = new MeetingRepository(db);
  const segments = new SegmentRepository(db);
  const created: string[] = [];
  const dirs: string[] = [];

  const newMeeting = async () => {
    const m = await meetings.create("spool", await testOwner(db));
    created.push(m.id);
    return m;
  };
  const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), "spool-it-"));
    dirs.push(dir);
    return dir;
  };
  const draft = (i: number) => ({ text: `seg ${i}`, startMs: i * 1000, endMs: i * 1000 + 900 });
  const unreachable = () =>
    ({
      head: (id: string) => segments.head(id),
      findBySeq: async () => null,
      appendIgnore: async () => {
        throw Object.assign(new Error("Failed to connect"), { code: "ERR_POSTGRES_CONNECTION_REFUSED" });
      },
    }) as unknown as SegmentRepository;

  afterAll(async () => {
    if (created.length) await meetings.deleteWhere(inArray(meetingsTable.id, created));
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    await client?.close();
  });

  test("a producer killed while the database is unreachable loses nothing: the next one replays the spool", async () => {
    const m = await newMeeting();
    const spoolDir = tmp();

    const child = Bun.spawn([process.execPath, "src/log/spool-crash.fixture.ts", m.id, spoolDir], {
      stdout: "pipe",
      stderr: "inherit",
    });
    const reader = child.stdout.getReader();
    let out = "";
    while (!out.includes("READY")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`fixture exited early: ${out}`);
      out += new TextDecoder().decode(chunk.value);
    }
    expect(await segments.head(m.id)).toBe(0); // nothing reached the database
    child.kill(); // hard kill, no cleanup runs
    await child.exited;

    // Postgres frees the dead producer's lock once it notices the connection is gone
    let successor: SegmentAppender | undefined;
    await until(async () => {
      try {
        successor = await SegmentAppender.open({ sql, segments, spoolDir, lockCheckMs: 0 }, m.id);
        return true;
      } catch (error) {
        if (error instanceof ProducerAlreadyActiveError) return false;
        throw error;
      }
    });
    expect(successor!.replayed).toBe(4);
    await successor!.flush();
    await successor!.append(draft(5));
    await successor!.close();

    const rows = await segments.readAfter(m.id, 0, 10);
    expect(rows.map((r) => [r.seq, r.meetingId === m.id, r.speakerKey])).toEqual([
      [1, true, "spk_0"],
      [2, true, "spk_1"],
      [3, true, "spk_0"],
      [4, true, "spk_1"],
      [5, true, null],
    ]);
    expect(rows.map((r) => r.text)).toEqual(["crash 1", "crash 2", "crash 3", "crash 4", "seg 5"]);
    expect(statSync(join(spoolDir, `${m.id}.ndjson`)).size).toBe(0); // fully written, spool emptied
  });

  test("replay skips what the database already has and numbers new rows after the spool", async () => {
    const m = await newMeeting();
    const spoolDir = tmp();
    const seeded = new SegmentSpool(spoolDir, m.id);
    for (let i = 1; i <= 3; i++) {
      seeded.append({
        seq: i,
        speakerKey: null,
        text: `seg ${i}`,
        startMs: i * 1000,
        endMs: i * 1000 + 900,
        source: "stt",
      });
    }
    seeded.close();
    // rows 1 and 2 made it to the database before the crash
    const first = await SegmentAppender.open({ sql, segments, lockCheckMs: 0 }, m.id);
    await first.append(draft(1));
    await first.append(draft(2));
    await first.close();

    const appender = await SegmentAppender.open({ sql, segments, spoolDir, lockCheckMs: 0 }, m.id);
    expect(appender.replayed).toBe(1);
    await appender.flush();
    const next = await appender.append(draft(4));
    expect(next.seq).toBe(4);
    await appender.close();
    expect((await segments.readAfter(m.id, 0, 10)).map((r) => r.seq)).toEqual([1, 2, 3, 4]);
  });

  test("the spool is emptied as soon as the database has everything", async () => {
    const m = await newMeeting();
    const spoolDir = tmp();
    const appender = await SegmentAppender.open({ sql, segments, spoolDir, lockCheckMs: 0 }, m.id);
    await Promise.all([1, 2, 3].map((i) => appender.append(draft(i))));
    await appender.flush();
    expect(statSync(join(spoolDir, `${m.id}.ndjson`)).size).toBe(0);
    await appender.close();
  });

  test("rows abandoned at close stay in the spool for the next producer", async () => {
    const m = await newMeeting();
    const spoolDir = tmp();
    const appender = await SegmentAppender.open(
      {
        sql,
        segments: unreachable(),
        spoolDir,
        retryBaseMs: 5,
        retryMaxMs: 20,
        lockCheckMs: 0,
        closeDrainMs: 50,
        probeBeforeWrite: false,
      },
      m.id,
    );
    appender.append(draft(1)).catch(() => undefined);
    appender.append(draft(2)).catch(() => undefined);
    await appender.close();
    expect(await segments.head(m.id)).toBe(0);

    const next = await SegmentAppender.open({ sql, segments, spoolDir, lockCheckMs: 0 }, m.id);
    expect(next.replayed).toBe(2);
    await next.flush();
    await next.close();
    expect((await segments.readAfter(m.id, 0, 10)).map((r) => r.text)).toEqual(["seg 1", "seg 2"]);
  });

  test("probe: a lost lock is noticed at the next write, with no monitor running, and the producer recovers", async () => {
    const m = await newMeeting();
    const appender = await SegmentAppender.open(
      { sql, segments, lockCheckMs: 0, maxAttempts: 40, retryBaseMs: 20, retryMaxMs: 50 },
      m.id,
    );
    await appender.append(draft(1));
    const before = appender.lockPid;
    await db.execute(rawSql`SELECT pg_terminate_backend(${before})`);
    await sleep(50);

    await appender.append(draft(2)); // probe sees the loss, takes the lock back, then writes
    expect(appender.lockPid).not.toBe(before);
    expect((await segments.readAfter(m.id, 0, 10)).map((r) => r.seq)).toEqual([1, 2]);
    await appender.close();
  });

  test("probe: if another producer took the lock, the old one writes nothing more", async () => {
    const m = await newMeeting();
    const appender = await SegmentAppender.open(
      { sql, segments, lockCheckMs: 0, maxAttempts: 40, retryBaseMs: 20, retryMaxMs: 50 },
      m.id,
    );
    await appender.append(draft(1));
    await db.execute(rawSql`SELECT pg_terminate_backend(${appender.lockPid})`);
    const interloper = await tryAdvisoryLock(sql, PRODUCER_LOCK, m.id);
    expect(interloper).not.toBeNull();

    await expect(appender.append(draft(2))).rejects.toBeInstanceOf(ProducerLockLostError);
    expect(await segments.head(m.id)).toBe(1);

    await interloper!.release();
    await appender.close();
  });
});
