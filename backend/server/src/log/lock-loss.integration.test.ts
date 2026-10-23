import { sql as rawSql } from "drizzle-orm";
import { afterAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { env } from "../env";
import { createDb, type DbClient } from "../db/client";
import { tryAdvisoryLock } from "../db/locks";
import { MeetingRepository } from "../db/repositories/meeting.repository";
import { SegmentRepository } from "../db/repositories/segment.repository";
import { meetings as meetingsTable, transcriptSegments } from "../db/schema";
import { PRODUCER_LOCK, SegmentAppender } from "./append";
import { MeetingGoneError, ProducerFailedError, ProducerLockLostError } from "./errors";
import { endOrphanedMeetings } from "./sweep";

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
async function until(cond: () => boolean | Promise<boolean>, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(10);
  }
  throw new Error("timed out waiting for condition");
}

run("lock loss, heartbeat and orphan sweep (postgres)", () => {
  const { db, sql } = client ?? ({} as DbClient);
  const meetings = new MeetingRepository(db);
  const segments = new SegmentRepository(db);
  const created: string[] = [];

  const newMeeting = async () => {
    const m = await meetings.create("lock-loss");
    created.push(m.id);
    return m;
  };
  const draft = (i: number) => ({ text: `seg ${i}`, startMs: i * 1000, endMs: i * 1000 + 900 });
  const kill = (pid: number) => db.execute(rawSql`SELECT pg_terminate_backend(${pid})`);
  const patient = { maxAttempts: 40, retryBaseMs: 20, retryMaxMs: 50 };

  afterAll(async () => {
    if (created.length) await meetings.deleteWhere(inArray(meetingsTable.id, created));
    await client?.close();
  });

  test("isHeld is true while the session lives and false once the backend is killed", async () => {
    const m = await newMeeting();
    const lock = await tryAdvisoryLock(sql, PRODUCER_LOCK, m.id);
    expect(lock).not.toBeNull();
    expect(await lock!.isHeld()).toBe(true);

    await kill(lock!.pid);
    await until(async () => !(await lock!.isHeld(500)));

    // the lock really is free now: someone else can take it
    const other = await tryAdvisoryLock(sql, PRODUCER_LOCK, m.id);
    expect(other).not.toBeNull();
    await other!.release();
    await lock!.release().catch(() => undefined);
  });

  test("a producer whose lock connection dies takes the lock back and keeps writing", async () => {
    const m = await newMeeting();
    let beats = 0;
    const appender = await SegmentAppender.open(
      { sql, segments, ...patient, lockCheckMs: 40, onHeartbeat: async () => void beats++ },
      m.id,
    );
    await appender.append(draft(1));
    const before = appender.lockPid;

    await kill(before);
    await until(() => appender.lockPid !== before);
    await appender.append(draft(2));
    await appender.append(draft(3));

    expect((await segments.readAfter(m.id, 0, 10)).map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(beats).toBeGreaterThan(1);
    await appender.close();
  });

  test("writes wait instead of landing while the lock is unverified", async () => {
    const m = await newMeeting();
    const appender = await SegmentAppender.open(
      { sql, segments, ...patient, lockCheckMs: 60 },
      m.id,
    );
    await appender.append(draft(1));
    const before = appender.lockPid;
    await kill(before);
    await sleep(150); // let the monitor notice
    await appender.append(draft(2)); // waits for the lock to be back, then lands
    expect(appender.lockPid).not.toBe(before);
    expect(await segments.head(m.id)).toBe(2);
    await appender.close();
  });

  test("if another producer took the lock meanwhile, the old one stops for good", async () => {
    const m = await newMeeting();
    const appender = await SegmentAppender.open(
      { sql, segments, ...patient, lockCheckMs: 100 },
      m.id,
    );
    await appender.append(draft(1));

    await kill(appender.lockPid);
    const interloper = await tryAdvisoryLock(sql, PRODUCER_LOCK, m.id);
    expect(interloper).not.toBeNull();
    await sleep(250); // monitor notices the loss and starts trying to reacquire

    await expect(appender.append(draft(2))).rejects.toBeInstanceOf(ProducerLockLostError);
    await expect(appender.append(draft(3))).rejects.toBeInstanceOf(ProducerLockLostError);
    expect(await segments.head(m.id)).toBe(1);

    await interloper!.release();
    await appender.close();
  });

  test("a new producer that wrote rows during the gap makes the old one fail on reacquire", async () => {
    const m = await newMeeting();
    const appender = await SegmentAppender.open(
      { sql, segments, ...patient, lockCheckMs: 150 },
      m.id,
    );
    await appender.append(draft(1));

    await kill(appender.lockPid);
    const successor = await SegmentAppender.open({ sql, segments, lockCheckMs: 0 }, m.id);
    await successor.append(draft(2));
    await successor.close();
    await sleep(300);

    await expect(appender.append(draft(3))).rejects.toBeInstanceOf(ProducerLockLostError);
    expect(await segments.head(m.id)).toBe(2);
    await appender.close();
  });

  test("retryMaxMs caps the backoff and a flaky database is ridden out", async () => {
    const m = await newMeeting();
    let failures = 4;
    const flaky = {
      head: (id: string) => segments.head(id),
      findBySeq: (id: string, seq: number) => segments.findBySeq(id, seq),
      appendIgnore: async (rows: Parameters<SegmentRepository["appendIgnore"]>[0]) => {
        if (failures-- > 0) throw new Error("connection reset");
        return segments.appendIgnore(rows);
      },
    } as unknown as SegmentRepository;

    const appender = await SegmentAppender.open(
      { sql, segments: flaky, maxAttempts: 8, retryBaseMs: 50, retryMaxMs: 60, lockCheckMs: 0 },
      m.id,
    );
    const started = Date.now();
    await appender.append(draft(1));
    const elapsed = Date.now() - started;

    // waits are 50 + 60 + 60 + 60 = 230ms; uncapped doubling would take 750ms
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(600);
    await appender.close();
  });

  test("a write that keeps failing past maxAttempts poisons the appender", async () => {
    const m = await newMeeting();
    const dead = {
      head: (id: string) => segments.head(id),
      findBySeq: async () => null,
      appendIgnore: async () => {
        throw new Error("connection reset");
      },
    } as unknown as SegmentRepository;
    const appender = await SegmentAppender.open(
      { sql, segments: dead, maxAttempts: 3, retryBaseMs: 1, lockCheckMs: 0 },
      m.id,
    );
    await expect(appender.append(draft(1))).rejects.toThrow("connection reset");
    await expect(appender.append(draft(2))).rejects.toBeInstanceOf(ProducerFailedError);
    await appender.close();
  });

  test("setStatus keeps startedAt across a resume and clears endedAt", async () => {
    const m = await newMeeting();
    const live = await meetings.setStatus(m.id, "live");
    expect(live?.startedAt).toBeInstanceOf(Date);
    const ended = await meetings.setStatus(m.id, "ended");
    expect(ended?.endedAt).toBeInstanceOf(Date);

    await sleep(20);
    const resumed = await meetings.setStatus(m.id, "live");
    expect(resumed?.startedAt?.getTime()).toBe(live!.startedAt!.getTime());
    expect(resumed?.endedAt).toBeNull();
  });

  test("the sweep ends a stale meeting with no lock holder and spares one with a live producer", async () => {
    const dead = await newMeeting();
    const alive = await newMeeting();
    for (const m of [dead, alive]) {
      await meetings.setStatus(m.id, "live");
      await meetings.touchHeartbeat(m.id, new Date(Date.now() - 5 * 60_000));
    }
    const producer = await SegmentAppender.open({ sql, segments, lockCheckMs: 0 }, alive.id);

    const mine = (await Promise.all(created.map((id) => meetings.findById(id)))).filter(
      (m): m is NonNullable<typeof m> => m?.status === "live",
    );
    const ended = await endOrphanedMeetings({
      meetings: {
        listByStatus: async () => mine,
        setStatus: (id, status) => meetings.setStatus(id, status),
      },
      tryLock: (id) => tryAdvisoryLock(sql, PRODUCER_LOCK, id),
    });

    expect(ended).toContain(dead.id);
    expect(ended).not.toContain(alive.id);
    expect((await meetings.findById(dead.id))?.status).toBe("ended");
    expect((await meetings.findById(alive.id))?.status).toBe("live");
    await producer.close();
  });

  test("a recent heartbeat protects a meeting even when its lock is free", async () => {
    const m = await newMeeting();
    await meetings.setStatus(m.id, "live");
    await meetings.touchHeartbeat(m.id);
    const ended = await endOrphanedMeetings({
      meetings: {
        listByStatus: async () => [(await meetings.findById(m.id))!],
        setStatus: (id, status) => meetings.setStatus(id, status),
      },
      tryLock: (id) => tryAdvisoryLock(sql, PRODUCER_LOCK, id),
    });
    expect(ended).toEqual([]);
    expect((await meetings.findById(m.id))?.status).toBe("live");
  });
  test("an outage far longer than maxAttempts is survived: rows wait, then land in order under the same meeting", async () => {
    const m = await newMeeting();
    let down = true;
    const outage = (): Error =>
      Object.assign(new Error("Failed to connect"), { code: "ERR_POSTGRES_CONNECTION_REFUSED" });
    const flaky = {
      head: (id: string) => segments.head(id),
      findBySeq: (id: string, seq: number) => segments.findBySeq(id, seq),
      appendIgnore: async (rows: Parameters<SegmentRepository["appendIgnore"]>[0]) => {
        if (down) throw outage();
        return segments.appendIgnore(rows);
      },
    } as unknown as SegmentRepository;

    const health: string[] = [];
    const appender = await SegmentAppender.open(
      {
        sql,
        segments: flaky,
        maxAttempts: 3, // would have given up after ~3 tries before
        retryBaseMs: 5,
        retryMaxMs: 20,
        lockCheckMs: 0,
        onHealth: (h) => health.push(h.state),
      },
      m.id,
    );

    const writes = [1, 2, 3, 4, 5].map((i) => appender.append(draft(i)));
    await sleep(400); // ~20 failed attempts per row
    expect(appender.pending).toBe(5);
    expect(await segments.head(m.id)).toBe(0);
    expect(health).toEqual(["degraded"]);

    down = false;
    const rows = await Promise.all(writes);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    expect((await segments.readAfter(m.id, 0, 10)).map((r) => r.meetingId)).toEqual(Array(5).fill(m.id));
    expect(appender.pending).toBe(0);
    expect(health).toEqual(["degraded", "ok"]);
    await appender.close();
  });

  test("close() gives up on rows the database never took instead of hanging", async () => {
    const m = await newMeeting();
    const dead = {
      head: (id: string) => segments.head(id),
      findBySeq: async () => null,
      appendIgnore: async () => {
        throw Object.assign(new Error("Failed to connect"), { code: "ERR_POSTGRES_CONNECTION_REFUSED" });
      },
    } as unknown as SegmentRepository;
    const appender = await SegmentAppender.open(
      { sql, segments: dead, retryBaseMs: 5, retryMaxMs: 20, lockCheckMs: 0, closeDrainMs: 100 },
      m.id,
    );
    const write = appender.append(draft(1));
    write.catch(() => undefined);
    const started = Date.now();
    await appender.close();
    expect(Date.now() - started).toBeLessThan(1500);
    await expect(write).rejects.toThrow();
  });

  test("after every other database connection is killed, the producer reattaches, flips an ended meeting back to live and keeps its seq", async () => {
    const m = await newMeeting();
    await meetings.setStatus(m.id, "live");
    let reattached = 0;
    const appender = await SegmentAppender.open(
      {
        sql,
        segments,
        ...patient,
        lockCheckMs: 50,
        onReattach: async (id) => {
          reattached++;
          const row = await meetings.findById(id);
          if (row && row.status !== "live") await meetings.setStatus(id, "live");
        },
      },
      m.id,
    );
    await appender.append(draft(1));
    await appender.append(draft(2));

    // the sweep ended it during the "outage", then every other connection dies
    await meetings.setStatus(m.id, "ended");
    const before = appender.lockPid;
    await db.execute(rawSql`
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()`);

    try {
      await Promise.all([3, 4, 5].map((i) => appender.append(draft(i))));
      // writes can land through the reconnected pool before the monitor notices the
      // lock is gone; the lock is taken back within a couple of ticks regardless
      await until(() => appender.lockPid !== before);

      expect((await segments.readAfter(m.id, 0, 10)).map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(reattached).toBeGreaterThanOrEqual(1);
      expect((await meetings.findById(m.id))?.status).toBe("live");
    } finally {
      await appender.close();
    }
  });
  const statusOf = (id: string) => async () => (await meetings.findById(id))?.status ?? null;
  const revive = async (id: string) => {
    await meetings.setStatus(id, "live");
  };

  test("a meeting ended behind the producer's back is put back to live on the next tick", async () => {
    const m = await newMeeting();
    await meetings.setStatus(m.id, "live");
    const appender = await SegmentAppender.open(
      { sql, segments, lockCheckMs: 40, readMeetingStatus: (id) => statusOf(id)(), onReattach: revive },
      m.id,
    );
    try {
      await meetings.setStatus(m.id, "ended");
      await until(async () => (await meetings.findById(m.id))?.status === "live");
    } finally {
      await appender.close();
    }
  });

  test("a producer whose meeting was deleted stops for good", async () => {
    const m = await newMeeting();
    const appender = await SegmentAppender.open(
      { sql, segments, ...patient, lockCheckMs: 40, readMeetingStatus: (id) => statusOf(id)(), onReattach: revive },
      m.id,
    );
    try {
      await appender.append(draft(1));
      await meetings.deleteWhere(inArray(meetingsTable.id, [m.id]));
      await sleep(150);
      await expect(appender.append(draft(2))).rejects.toBeInstanceOf(MeetingGoneError);
    } finally {
      await appender.close();
    }
  });

  test("a meeting deleted while the lock is also lost does not leave the producer retrying forever", async () => {
    const m = await newMeeting();
    const appender = await SegmentAppender.open(
      { sql, segments, ...patient, lockCheckMs: 40, readMeetingStatus: (id) => statusOf(id)(), onReattach: revive },
      m.id,
    );
    try {
      await meetings.deleteWhere(inArray(meetingsTable.id, [m.id]));
      await kill(appender.lockPid);
      await sleep(200);
      await expect(appender.append(draft(1))).rejects.toBeInstanceOf(MeetingGoneError);
    } finally {
      await appender.close();
    }
  });

  test("coming back from an outage confirms the producer is alive at once, without waiting for a tick", async () => {
    const m = await newMeeting();
    await meetings.setStatus(m.id, "live");
    let down = true;
    const flaky = {
      head: (id: string) => segments.head(id),
      findBySeq: (id: string, seq: number) => segments.findBySeq(id, seq),
      appendIgnore: async (rows: Parameters<SegmentRepository["appendIgnore"]>[0]) => {
        if (down) throw Object.assign(new Error("x"), { code: "ERR_POSTGRES_CONNECTION_REFUSED" });
        return segments.appendIgnore(rows);
      },
    } as unknown as SegmentRepository;
    let beats = 0;
    const appender = await SegmentAppender.open(
      {
        sql,
        segments: flaky,
        retryBaseMs: 5,
        retryMaxMs: 20,
        lockCheckMs: 0, // no monitor: only the recovery path can do this
        probeBeforeWrite: false,
        readMeetingStatus: (id) => statusOf(id)(),
        onReattach: revive,
        onHeartbeat: async (id) => {
          beats++;
          await meetings.touchHeartbeat(id);
        },
      },
      m.id,
    );
    try {
      const write = appender.append(draft(1));
      await sleep(100);
      await meetings.setStatus(m.id, "ended"); // the sweep got there during the outage
      down = false;
      await write;
      await until(async () => (await meetings.findById(m.id))?.status === "live");
      expect(beats).toBeGreaterThanOrEqual(1);
    } finally {
      await appender.close();
    }
  });
});
