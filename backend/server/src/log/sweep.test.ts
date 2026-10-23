import { describe, expect, test } from "bun:test";
import type { AdvisoryLock } from "../db/locks";
import type { Meeting } from "../db/schema";
import { endOrphanedMeetings } from "./sweep";

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const ago = (ms: number) => new Date(NOW - ms);

const meeting = (id: string, heartbeatAgoMs: number | null, extra: Partial<Meeting> = {}) =>
  ({
    id,
    producerHeartbeatAt: heartbeatAgoMs === null ? null : ago(heartbeatAgoMs),
    startedAt: ago(3_600_000),
    createdAt: ago(3_600_000),
    ...extra,
  }) as Meeting;

const lockFor = (id: string, released: string[]): AdvisoryLock => ({
  key: id,
  pid: 1,
  isHeld: async () => true,
  release: async () => void released.push(id),
});

function harness(live: Meeting[], held: string[] = []) {
  const ended: string[] = [];
  const released: string[] = [];
  const tried: string[] = [];
  return {
    ended,
    released,
    tried,
    run: (graceMs = 60_000) =>
      endOrphanedMeetings({
        graceMs,
        now: () => NOW,
        meetings: {
          listByStatus: async () => live,
          setStatus: async (id: string) => (ended.push(id), null),
        },
        tryLock: async (id) => {
          tried.push(id);
          return held.includes(id) ? null : lockFor(id, released);
        },
      }),
  };
}

describe("endOrphanedMeetings", () => {
  test("ends a stale meeting whose lock is free", async () => {
    const h = harness([meeting("dead", 120_000)]);
    expect(await h.run()).toEqual(["dead"]);
    expect(h.ended).toEqual(["dead"]);
    expect(h.released).toEqual(["dead"]);
  });

  test("leaves a meeting alone while its heartbeat is inside the grace window", async () => {
    const h = harness([meeting("recovering", 30_000)]);
    expect(await h.run()).toEqual([]);
    expect(h.tried).toEqual([]); // never races a reconnecting producer for the lock
  });

  test("leaves a meeting alone while someone holds the lock and the heartbeat is only mildly stale", async () => {
    const h = harness([meeting("reconnecting", 300_000)], ["reconnecting"]);
    expect(await h.run()).toEqual([]);
    expect(h.ended).toEqual([]);
  });

  test("ends a meeting whose heartbeat is long dead even though a lock is held", async () => {
    const h = harness([meeting("partitioned", 900_000)], ["partitioned"]);
    expect(await h.run()).toEqual(["partitioned"]);
    expect(h.ended).toEqual(["partitioned"]);
    expect(h.released).toEqual([]); // nothing to release, the dead session owns it
  });

  test("staleMs is configurable", async () => {
    const h = harness([meeting("p", 120_000)], ["p"]);
    const ended = await endOrphanedMeetings({
      graceMs: 60_000,
      staleMs: 100_000,
      now: () => NOW,
      meetings: {
        listByStatus: async () => [meeting("p", 120_000)],
        setStatus: async (id: string) => (h.ended.push(id), null),
      },
      tryLock: async () => null,
    });
    expect(ended).toEqual(["p"]);
  });

  test("a meeting that never sent a heartbeat ages from startedAt, then createdAt", async () => {
    const h = harness([
      meeting("old-start", null, { startedAt: ago(300_000) }),
      meeting("fresh-start", null, { startedAt: ago(10_000) }),
      meeting("no-start-old", null, { startedAt: null, createdAt: ago(300_000) }),
    ]);
    expect((await h.run()).sort()).toEqual(["no-start-old", "old-start"]);
  });

  test("a quiet meeting with a healthy producer keeps beating and is never ended", async () => {
    const h = harness([meeting("quiet", 5_000)]);
    expect(await h.run()).toEqual([]);
  });

  test("releases the lock even when ending the meeting fails", async () => {
    const released: string[] = [];
    await expect(
      endOrphanedMeetings({
        now: () => NOW,
        meetings: {
          listByStatus: async () => [meeting("m", 600_000)],
          setStatus: async () => {
            throw new Error("boom");
          },
        },
        tryLock: async (id) => lockFor(id, released),
      }),
    ).rejects.toThrow("boom");
    expect(released).toEqual(["m"]);
  });
});
