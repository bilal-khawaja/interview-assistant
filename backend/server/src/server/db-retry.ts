import { isTransientDbError } from "../db/transient";
import { abortableSleep, backoffMs } from "../retry";
import type { Frame } from "./frames";

export type RetryOptions = { retryBaseMs?: number; retryMaxMs?: number };

/**
 * A database outage is not the client's fault: keep the socket open, tell the client once
 * that reads are stalled, and retry until the database answers or the client leaves.
 * Errors that retrying cannot fix are rethrown.
 */
export function createRetrying(
  send: (frame: Frame) => void,
  signal: AbortSignal,
  options: RetryOptions = {},
) {
  let degraded = false;
  let failures = 0;

  return async function retrying<T>(read: () => Promise<T>, whileAborted: T): Promise<T> {
    for (;;) {
      try {
        const result = await read();
        if (degraded) {
          degraded = false;
          failures = 0;
          send({ type: "recovered" });
        }
        return result;
      } catch (error) {
        if (signal.aborted) return whileAborted;
        if (!isTransientDbError(error)) throw error;
        if (!degraded) {
          degraded = true;
          send({
            type: "degraded",
            reason: error instanceof Error ? error.message : "database unavailable",
          });
        }
        failures++;
        await abortableSleep(
          backoffMs(failures, options.retryBaseMs ?? 500, options.retryMaxMs ?? 10_000),
          signal,
        );
        if (signal.aborted) return whileAborted;
      }
    }
  };
}
