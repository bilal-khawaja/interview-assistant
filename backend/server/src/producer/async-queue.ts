export class QueueOverflowError extends Error {
  constructor(readonly capacity: number) {
    super(`producer backlog overflow: more than ${capacity} segments waiting to be written`);
    this.name = "QueueOverflowError";
  }
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiting: (() => void) | null = null;
  private closed = false;
  private failure: unknown = null;

  constructor(private readonly capacity: number = Infinity) {}

  get size(): number {
    return this.items.length;
  }

  push(item: T): boolean {
    if (this.closed) return false;
    if (this.items.length >= this.capacity) {
      this.close(new QueueOverflowError(this.capacity));
      return false;
    }
    this.items.push(item);
    this.wake();
    return true;
  }

  close(error?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error ?? null;
    this.wake();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const item = this.items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.closed) {
        if (this.failure) throw this.failure;
        return;
      }
      await new Promise<void>((resolve) => (this.waiting = resolve));
    }
  }

  private wake(): void {
    const resolve = this.waiting;
    this.waiting = null;
    resolve?.();
  }
}
