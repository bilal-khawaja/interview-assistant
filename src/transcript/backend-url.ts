export const DEFAULT_BACKEND_URL = 'http://localhost:3000';

/** Trims whitespace and trailing slashes; throws on anything that is not http(s). */
export function normalizeBackendUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  const url = new URL(trimmed);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('backend URL must start with http:// or https://');
  }
  return trimmed;
}

/** http(s)://host -> ws(s)://host. */
export function toWebSocketUrl(httpUrl: string): string {
  return httpUrl.replace(/^http/i, 'ws');
}

/** Delay before reconnect attempt n (1-based): exponential, capped, with up to 25% jitter. */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number, random = Math.random): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.75 + random() * 0.25));
}
