import type { SQL as BunSQL } from "bun";

export const TRANSCRIPT_CHANNEL = "transcript_segments";

export class WakeSubscription {
  pending = false;
  private resolve: (() => void) | null = null;

  constructor(private readonly onClose: () => void) {}

  notify(): void {
    this.pending = true;
    this.resolve?.();
  }

  clear(): void {
    this.pending = false;
  }

  sleep(signal: AbortSignal, pollMs: number): Promise<void> {
    if (this.pending || signal.aborted) return Promise.resolve();
    return new Promise<void>((done) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        this.resolve = null;
        done();
      };
      const timer = setTimeout(finish, pollMs);
      signal.addEventListener("abort", finish, { once: true });
      this.resolve = finish;
    });
  }

  close(): void {
    this.onClose();
  }
}

export class WakeHub {
  private readonly subs = new Map<string, Set<WakeSubscription>>();

  subscribe(meetingId: string): WakeSubscription {
    let set = this.subs.get(meetingId);
    if (!set) this.subs.set(meetingId, (set = new Set()));
    const bucket = set;
    const sub: WakeSubscription = new WakeSubscription(() => {
      bucket.delete(sub);
      if (bucket.size === 0 && this.subs.get(meetingId) === bucket) {
        this.subs.delete(meetingId);
      }
    });
    bucket.add(sub);
    return sub;
  }

  wake(meetingId: string): void {
    for (const sub of this.subs.get(meetingId) ?? []) sub.notify();
  }

  wakeAll(): void {
    for (const set of this.subs.values()) for (const sub of set) sub.notify();
  }

  size(): number {
    let n = 0;
    for (const set of this.subs.values()) n += set.size;
    return n;
  }
}

export class PgWakeBridge {
  private subscription: { unlisten(): Promise<void> } | null = null;

  constructor(
    private readonly sql: BunSQL,
    private readonly hub: WakeHub,
    private readonly channel: string = TRANSCRIPT_CHANNEL,
  ) {}

  async start(): Promise<void> {
    if (this.subscription) return;
    this.subscription = await this.sql.listen(
      this.channel,
      (meetingId) => this.hub.wake(meetingId),
      () => this.hub.wakeAll(),
    );
  }

  async stop(): Promise<void> {
    const sub = this.subscription;
    this.subscription = null;
    await sub?.unlisten();
  }
}
