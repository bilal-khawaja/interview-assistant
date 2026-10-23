const BUN_TRANSIENT = new Set([
  "ERR_POSTGRES_CONNECTION_CLOSED",
  "ERR_POSTGRES_CONNECTION_REFUSED",
  "ERR_POSTGRES_CONNECTION_TIMEOUT",
  "ERR_POSTGRES_IDLE_TIMEOUT",
  "ERR_POSTGRES_LIFETIME_TIMEOUT",
]);

const NODE_TRANSIENT = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

/**
 * True for errors that say the database is unreachable or restarting, as
 * opposed to errors about the data itself. Retrying the first kind can
 * eventually succeed; retrying the second never will.
 */
export function isTransientDbError(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    const { code, errno } = e as { code?: unknown; errno?: unknown };
    for (const value of [code, errno]) {
      if (typeof value !== "string") continue;
      if (BUN_TRANSIENT.has(value) || NODE_TRANSIENT.has(value)) return true;
      // 08: connection exception, 57P01-03: server shutdown / starting up
      if (value.startsWith("08") || /^57P0[123]$/.test(value)) return true;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
