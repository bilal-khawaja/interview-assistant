import type { AdvisoryLock } from "../db/locks";
import type { MeetingRepository } from "../db/repositories/meeting.repository";
import type { Meeting } from "../db/schema";

// Longer than the producer's database retry window plus one lock check.
export const ORPHAN_GRACE_MS = 60_000;
// A producer cut off from the network keeps its lock until Postgres notices the dead
// socket. Past this age the lock no longer counts as proof of life.
export const ORPHAN_STALE_MS = 10 * 60_000;

export type SweepDeps = {
  meetings: Pick<MeetingRepository, "listByStatus" | "setStatus">;
  tryLock: (meetingId: string) => Promise<AdvisoryLock | null>;
  graceMs?: number;
  staleMs?: number;
  now?: () => number;
};

export function lastProducerSignal(meeting: Meeting): number {
  const at = meeting.producerHeartbeatAt ?? meeting.startedAt ?? meeting.createdAt;
  return at.getTime();
}

/**
 * Ends meetings still marked live whose producer is gone. A meeting counts as
 * orphaned when its heartbeat is older than the grace window and nobody holds its
 * producer advisory lock. The heartbeat check comes first so a producer that is still
 * reconnecting is never raced for its lock. A heartbeat older than staleMs ends the
 * meeting even with the lock held, since a partitioned producer keeps it for hours. If
 * that producer comes back, the appender sees the ended status and reattaches.
 */
export async function endOrphanedMeetings(deps: SweepDeps): Promise<string[]> {
  const graceMs = deps.graceMs ?? ORPHAN_GRACE_MS;
  const staleMs = deps.staleMs ?? ORPHAN_STALE_MS;
  const now = (deps.now ?? Date.now)();
  const ended: string[] = [];
  for (const meeting of await deps.meetings.listByStatus("live")) {
    const age = now - lastProducerSignal(meeting);
    if (age <= graceMs) continue;
    const lock = await deps.tryLock(meeting.id);
    if (!lock && age <= staleMs) continue;
    try {
      await deps.meetings.setStatus(meeting.id, "ended");
      ended.push(meeting.id);
    } finally {
      await lock?.release();
    }
  }
  return ended;
}

export function startOrphanSweeper(
  deps: SweepDeps,
  everyMs: number,
  onResult: (ended: string[], error?: unknown) => void,
): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      onResult(await endOrphanedMeetings(deps));
    } catch (error) {
      onResult([], error);
    } finally {
      running = false;
    }
  }, everyMs);
  return () => clearInterval(timer);
}
