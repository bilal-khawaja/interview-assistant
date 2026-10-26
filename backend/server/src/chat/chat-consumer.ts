import { dedupeHandler } from "../log/dedupe";
import type { AttachMode, CursorService } from "../log/cursor";
import type { TranscriptConsumer } from "../log/consumer";
import type { ChatRunner } from "./runner";

export type ChatConsumerOptions = {
  consumer: TranscriptConsumer;
  runner: ChatRunner;
  cursors: CursorService;
  meetingId: string;
  chatId: string;
  signal: AbortSignal;
  /** Where a chat with no cursor yet starts reading. Default: the beginning of the meeting. */
  attach?: AttachMode;
  /** A turn failed; the batch is redelivered after a backoff. */
  onError?: (error: unknown) => void;
  onOutage?: (error: unknown, attempt: number) => void;
  /** Redeliveries of one batch before giving up and ending the consumer. Unlimited by default. */
  maxAttempts?: number;
};

/**
 * Feeds a meeting's transcript to one chat. The chat is an independent consumer: it has
 * its own cursor, and each batch is one transcript turn on the chat's coordinator queue.
 * The turn commits the cursor with its result, so a crash repeats at most the batch in flight.
 */
export async function runChatConsumer(options: ChatConsumerOptions): Promise<void> {
  const { runner, chatId } = options;
  const start = await options.cursors.attach(options.meetingId, chatId, options.attach);
  await options.consumer.run({
    meetingId: options.meetingId,
    chatId,
    signal: options.signal,
    maxAttempts: options.maxAttempts,
    onError: (error) => options.onError?.(error),
    onOutage: options.onOutage,
    handler: dedupeHandler(({ segments }) => runner.handleTranscript(chatId, segments), start),
  });
}
