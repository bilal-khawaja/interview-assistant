type Entry = { close(code: number, reason: string): void };

/**
 * The open sockets of a meeting by who opened them, so taking someone out of a meeting can
 * close what they already have open instead of waiting for them to reconnect.
 */
export class SocketRegistry {
  private readonly sockets = new Map<string, Set<Entry>>();

  /** Tracks a socket; call the returned function when it closes. */
  add(meetingId: string, userId: string, entry: Entry): () => void {
    const key = `${meetingId}:${userId}`;
    const set = this.sockets.get(key) ?? new Set<Entry>();
    set.add(entry);
    this.sockets.set(key, set);
    return () => {
      set.delete(entry);
      if (set.size === 0 && this.sockets.get(key) === set) this.sockets.delete(key);
    };
  }

  closeUser(meetingId: string, userId: string, code: number, reason: string): void {
    const set = this.sockets.get(`${meetingId}:${userId}`);
    if (!set) return;
    for (const entry of [...set]) entry.close(code, reason);
  }
}
