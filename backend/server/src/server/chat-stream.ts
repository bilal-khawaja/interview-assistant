import type { ChatMessageRepository } from "../db/repositories/chat-message.repository";
import type { ChatMessage } from "../db/schema";
import { consume } from "../log/consume";
import type { WakeHub } from "../log/wake";
import { createRetrying } from "./db-retry";
import {
  CLOSE_CURSOR_AHEAD,
  CLOSE_INTERNAL_ERROR,
  CLOSE_SLOW_CONSUMER,
  type MessageFrame,
} from "./frames";
import type { StreamSink } from "./transcript-stream";

export type ChatStreamDeps = {
  messages: Pick<ChatMessageRepository, "head" | "listAfter">;
  /** Woken with the chat id whenever a message is committed to that chat. */
  hub: WakeHub;
  heartbeatMs: number;
  maxBufferedBytes: number;
  batchSize?: number;
  pollMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
};

export function messageFrame(message: ChatMessage): MessageFrame {
  return {
    type: "message",
    id: message.id,
    seq: message.seq,
    role: message.role,
    kind: message.kind,
    content: message.content,
    transcriptSeq: message.transcriptSeq,
    createdAt: message.createdAt.toISOString(),
  };
}

/** Replays the chat's messages after `after`, then follows new ones until the client leaves. */
export async function runChatStream(
  deps: ChatStreamDeps,
  sink: StreamSink,
  meetingId: string,
  chatId: string,
  after: number,
  signal: AbortSignal,
): Promise<void> {
  let heartbeat: Timer | undefined;
  const retrying = createRetrying((frame) => sink.send(frame), signal, deps);

  try {
    const head = await deps.messages.head(chatId);
    if (after > head) {
      sink.send({
        type: "error",
        code: "cursor_ahead",
        message: `after=${after} is beyond the chat head ${head}`,
      });
      sink.close(CLOSE_CURSOR_AHEAD, "cursor ahead of head");
      return;
    }

    sink.send({ type: "ready", stream: "chat", meetingId, chatId, after, head, heartbeatMs: deps.heartbeatMs });
    heartbeat = setInterval(() => {
      sink.send({ type: "heartbeat", at: new Date().toISOString() });
    }, deps.heartbeatMs);

    const batches = consume(
      {
        hub: deps.hub,
        readAfter: (id, cursor, limit) => retrying(() => deps.messages.listAfter(id, cursor, limit), []),
        batchSize: deps.batchSize,
        pollMs: deps.pollMs,
      },
      chatId,
      after,
      signal,
    );

    for await (const batch of batches) {
      for (const message of batch) sink.send(messageFrame(message));
      if (sink.bufferedAmount() > deps.maxBufferedBytes) {
        sink.close(CLOSE_SLOW_CONSUMER, "slow consumer");
        return;
      }
    }
  } catch (error) {
    if (signal.aborted) return;
    sink.send({
      type: "error",
      code: "internal",
      message: error instanceof Error ? error.message : "stream failed",
    });
    sink.close(CLOSE_INTERNAL_ERROR, "stream failed");
  } finally {
    clearInterval(heartbeat);
  }
}
