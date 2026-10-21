import { describe, expect, test } from "bun:test";
import type { TranscriptSegment } from "../db/schema";
import { consume, type ReadAfter } from "./consume";
import { WakeHub } from "./wake";

const MEETING = "m1";

function seg(seq: number): TranscriptSegment {
  return {
    id: seq,
    meetingId: MEETING,
    seq,
    speakerKey: null,
    text: `s${seq}`,
    startMs: seq * 1000,
    endMs: seq * 1000 + 900,
    source: "stt",
    createdAt: new Date(0),
  };
}

function fakeLog() {
  const rows: TranscriptSegment[] = [];
  const state = { reads: 0, gate: null as null | Promise<void> };
  const readAfter: ReadAfter = async (_m, after, limit) => {
    state.reads++;
    const snapshot = rows.filter((r) => r.seq > after).slice(0, limit);
    if (state.gate) await state.gate;
    return snapshot;
  };
  const append = (hub: WakeHub, ...seqs: number[]) => {
    for (const s of seqs) rows.push(seg(s));
    hub.wake(MEETING);
  };
  return { rows, state, readAfter, append };
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe("consume", () => {
  test("ten appends during a slow read cause exactly one re-read", async () => {
    const hub = new WakeHub();
    const log = fakeLog();
    let release!: () => void;
    log.state.gate = new Promise<void>((r) => (release = r));

    const ac = new AbortController();
    const it = consume({ hub, readAfter: log.readAfter, pollMs: 60_000 }, MEETING, 0, ac.signal);
    const first = it.next();

    await tick();
    for (let i = 1; i <= 10; i++) log.append(hub, i);
    log.state.gate = null;
    release();

    const batch = await first;
    expect(batch.value?.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(log.state.reads).toBe(2);

    ac.abort();
    await it.next();
    expect(hub.size()).toBe(0);
  });

  test("an append between the empty read and the sleep is not lost", async () => {
    const hub = new WakeHub();
    const log = fakeLog();
    const ac = new AbortController();

    const racy: ReadAfter = async (m, after, limit) => {
      const rows = await log.readAfter(m, after, limit);
      if (log.state.reads === 1) log.append(hub, 1);
      return rows;
    };

    const it = consume({ hub, readAfter: racy, pollMs: 60_000 }, MEETING, 0, ac.signal);
    const batch = await Promise.race([
      it.next(),
      tick(500).then(() => "lost" as const),
    ]);
    expect(batch).not.toBe("lost");
    expect((batch as IteratorResult<TranscriptSegment[]>).value?.[0]?.seq).toBe(1);

    ac.abort();
    await it.next();
  });

  test("wake while idle delivers promptly; abort ends the generator and unsubscribes", async () => {
    const hub = new WakeHub();
    const log = fakeLog();
    const ac = new AbortController();
    const it = consume({ hub, readAfter: log.readAfter, pollMs: 60_000 }, MEETING, 0, ac.signal);

    const pending = it.next();
    await tick();
    expect(hub.size()).toBe(1);
    log.append(hub, 1);
    expect((await pending).value?.map((r) => r.seq)).toEqual([1]);

    const idle = it.next();
    await tick();
    ac.abort();
    expect((await idle).done).toBe(true);
    expect(hub.size()).toBe(0);
  });

  test("starts strictly after `from` and pages by batchSize in order", async () => {
    const hub = new WakeHub();
    const log = fakeLog();
    log.append(hub, 1, 2, 3, 4, 5);
    const ac = new AbortController();
    const it = consume(
      { hub, readAfter: log.readAfter, batchSize: 2, pollMs: 60_000 },
      MEETING,
      1,
      ac.signal,
    );
    const seen: number[][] = [];
    for (let i = 0; i < 2; i++) seen.push((await it.next()).value!.map((r) => r.seq));
    expect(seen).toEqual([[2, 3], [4, 5]]);
    ac.abort();
    await it.next();
  });

  test("two consumers each receive every row independently", async () => {
    const hub = new WakeHub();
    const log = fakeLog();
    const ac = new AbortController();
    const a = consume({ hub, readAfter: log.readAfter, pollMs: 60_000 }, MEETING, 0, ac.signal);
    const b = consume({ hub, readAfter: log.readAfter, pollMs: 60_000 }, MEETING, 0, ac.signal);
    const pa = a.next();
    const pb = b.next();
    await tick();
    log.append(hub, 1, 2);
    expect((await pa).value?.map((r) => r.seq)).toEqual([1, 2]);
    expect((await pb).value?.map((r) => r.seq)).toEqual([1, 2]);
    ac.abort();
    await a.next();
    await b.next();
    expect(hub.size()).toBe(0);
  });

  test("safety poll recovers a missed wake", async () => {
    const hub = new WakeHub();
    const log = fakeLog();
    const ac = new AbortController();
    const it = consume({ hub, readAfter: log.readAfter, pollMs: 30 }, MEETING, 0, ac.signal);
    const pending = it.next();
    await tick();
    log.rows.push(seg(1));
    expect((await pending).value?.map((r) => r.seq)).toEqual([1]);
    ac.abort();
    await it.next();
  });
});
