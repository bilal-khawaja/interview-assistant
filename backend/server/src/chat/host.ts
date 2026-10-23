import { ConsumerAlreadyActiveError, type TranscriptConsumer } from "../log/consumer";
import type { CursorService } from "../log/cursor";
import { runChatConsumer } from "./chat-consumer";
import type { ChatRunner } from "./runner";

export type HostDeps = {
  runner: ChatRunner;
  consumer: TranscriptConsumer;
  cursors: CursorService;
  onError?: (error: unknown, chatId: string) => void;
  onOutage?: (error: unknown, attempt: number, chatId: string) => void;
};

/**
 * Keeps one transcript consumer running per chat in this process. Another process may hold
 * a chat's consumer lock; this host then drops the chat and leaves it to that process.
 */
export class ChatHost {
  private readonly running = new Map<string, Promise<void>>();
  private readonly abort = new AbortController();

  constructor(private readonly deps: HostDeps) {}

  /** Idempotent: starting a chat that already runs here does nothing. */
  start(meetingId: string, chatId: string): void {
    if (this.running.has(chatId) || this.abort.signal.aborted) return;
    const task = runChatConsumer({
      consumer: this.deps.consumer,
      runner: this.deps.runner,
      cursors: this.deps.cursors,
      meetingId,
      chatId,
      signal: this.abort.signal,
      onError: (error) => this.deps.onError?.(error, chatId),
      onOutage: (error, attempt) => this.deps.onOutage?.(error, attempt, chatId),
    })
      .catch((error) => {
        if (!(error instanceof ConsumerAlreadyActiveError)) this.deps.onError?.(error, chatId);
      })
      .finally(() => this.running.delete(chatId));
    this.running.set(chatId, task);
  }

  get size(): number {
    return this.running.size;
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await Promise.allSettled([...this.running.values()]);
  }
}
