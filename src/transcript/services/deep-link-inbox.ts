import { parseJoinUrl } from '../deep-link';

/**
 * Holds the invite a clicked link carried until the window asks for it. The link can arrive
 * before any window exists (a cold start) or while one is still loading, so it is kept
 * rather than pushed and forgotten; the window takes it once it is listening.
 */
export class DeepLinkInbox {
  private pending: string | null = null;
  private readonly listeners = new Set<(token: string) => void>();

  /** Accepts a URL from the operating system. False when it is not a join link. */
  receive(url: string): boolean {
    const token = parseJoinUrl(url);
    if (token === null) return false;
    this.pending = token;
    for (const listener of this.listeners) listener(token);
    return true;
  }

  /** The waiting invite, which is forgotten once taken. */
  take(): string | null {
    const token = this.pending;
    this.pending = null;
    return token;
  }

  onToken(listener: (token: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
