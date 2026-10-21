/**
 * Runs tasks one at a time per key, in the order they were submitted, while tasks with
 * different keys run concurrently. A failed task rejects only its own caller; the next
 * task for the key still runs. In-process only: it does not coordinate several server
 * processes (the advisory lock in ChatMessageRepository.append keeps seq safe there).
 */
export class KeyedCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, settled);
    void settled.then(() => {
      if (this.tails.get(key) === settled) this.tails.delete(key);
    });
    return result;
  }

  /** Resolves once everything submitted for the key so far has finished. */
  async idle(key: string): Promise<void> {
    await this.tails.get(key);
  }

  /** Keys that currently have queued or running work. */
  get active(): number {
    return this.tails.size;
  }
}
