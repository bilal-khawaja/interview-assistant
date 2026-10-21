import type { SQL as BunSQL } from "bun";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

export type AdvisoryLock = {
  readonly key: string;
  /** Postgres backend pid of the session that holds the lock. */
  readonly pid: number;
  /**
   * True only while this session still holds the lock, confirmed in pg_locks.
   * A dead session, a replaced one, a missing lock row, an error or no answer
   * within timeoutMs all mean the lock is gone or unverifiable.
   */
  isHeld(timeoutMs?: number): Promise<boolean>;
  release(): Promise<void>;
};

const DEFAULT_PROBE_TIMEOUT_MS = 3_000;

export async function tryAdvisoryLock(
  client: BunSQL,
  namespace: string,
  id: string,
): Promise<AdvisoryLock | null> {
  const key = `${namespace}:${id}`;
  const conn = await client.reserve();
  const db = drizzle(conn);
  const hashed = sql`hashtextextended(${key}, 0)`;

  // Ask the server to probe this session's socket sooner than the OS default (about 2 h),
  // so a producer that vanished without closing it loses the lock within a minute or so.
  // Best effort: a server that refuses the settings still gives a working lock.
  try {
    await db.execute(sql`SELECT set_config('tcp_keepalives_idle', '20', false),
                                set_config('tcp_keepalives_interval', '10', false),
                                set_config('tcp_keepalives_count', '3', false)`);
  } catch {}

  let pid: number;
  try {
    const rows = await db.execute<{ locked: boolean; pid: number }>(
      sql`SELECT pg_try_advisory_lock(${hashed}) AS locked, pg_backend_pid() AS pid`,
    );
    if (!rows[0]?.locked) {
      conn.release();
      return null;
    }
    pid = Number(rows[0].pid);
  } catch (error) {
    conn.release();
    throw error;
  }

  let released = false;
  return {
    key,
    pid,
    async isHeld(timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
      if (released) return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Ask pg_locks, not just the pid: after a server restart a new backend can
        // reuse the old pid, but it will not hold this lock.
        const answer = await Promise.race([
          db.execute<{ pid: number; held: boolean }>(sql`
            SELECT pg_backend_pid() AS pid,
                   EXISTS (
                     SELECT 1 FROM pg_locks
                     WHERE locktype = 'advisory' AND granted AND objsubid = 1
                       AND pid = pg_backend_pid()
                       AND ((classid::bigint << 32) | objid::bigint) = ${hashed}
                   ) AS held`),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("lock probe timed out")), timeoutMs);
          }),
        ]);
        return Number(answer[0]?.pid) === pid && answer[0]?.held === true;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
    async release() {
      if (released) return;
      released = true;
      try {
        await db.execute(sql`SELECT pg_advisory_unlock(${hashed})`);
      } finally {
        conn.release();
      }
    },
  };
}
