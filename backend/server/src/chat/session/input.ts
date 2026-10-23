import type { Database } from "../../db/client";
import {
  ChatInboxRepository,
  type AdmitResult,
} from "../../db/repositories/chat-inbox.repository";
import { ChatMessageRepository } from "../../db/repositories/chat-message.repository";
import type { ChatInboxItem, ChatMessage, InboxMode } from "../../db/schema";
import type { KeyedCoordinator } from "../keyed-coordinator";

export type InputDeps = {
  db: Database;
  coordinator: KeyedCoordinator;
  /**
   * Called when a new steering input is admitted, so the turn running for that chat can
   * stop early and let the steer in. Follow-ups never call it; they wait their turn.
   */
  onSteer?: (chatId: string) => void;
  /** A background promotion failed. The item stays admitted and is retried by the next drain. */
  onError?: (error: unknown, chatId: string) => void;
};

export type Submitted = {
  created: boolean;
  /** Settles when the chat's pending inputs have been promoted. Safe to ignore. */
  promoted: Promise<ChatMessage[]>;
};

/**
 * Two-phase input. admit() records the input durably and idempotently by message id;
 * drain() later moves pending inputs into the chat history, inside the chat's
 * coordinator queue so it never runs in the middle of a turn. Promotion order is all
 * steers first, then follow-ups, each in admission order.
 */
export class ChatInput {
  private readonly inbox: ChatInboxRepository;

  constructor(private readonly deps: InputDeps) {
    this.inbox = new ChatInboxRepository(deps.db);
  }

  async admit(
    chatId: string,
    messageId: string,
    mode: InboxMode,
    text: string,
  ): Promise<AdmitResult> {
    const result = await this.inbox.admit(chatId, messageId, mode, text);
    if (result.created && mode === "steer") this.deps.onSteer?.(chatId);
    return result;
  }

  /** admit() plus a background drain, which also re-runs for a retried submit of a still-pending id. */
  async submit(
    chatId: string,
    messageId: string,
    mode: InboxMode,
    text: string,
  ): Promise<Submitted> {
    const { created } = await this.admit(chatId, messageId, mode, text);
    const promoted = this.drain(chatId);
    promoted.catch((error) => this.deps.onError?.(error, chatId));
    return { created, promoted };
  }

  /** Promotes everything pending for the chat once the chat's current work has finished. */
  drain(chatId: string): Promise<ChatMessage[]> {
    return this.deps.coordinator.run(chatId, async () => {
      const pending = order(await this.inbox.pending(chatId));
      const promoted: ChatMessage[] = [];
      for (const item of pending) promoted.push(await this.promote(item));
      return promoted;
    });
  }

  /**
   * Promotes the single most urgent pending input (oldest steer, else oldest follow-up),
   * or returns null. Not queued: call it from inside the chat's coordinator slot.
   */
  async promoteNext(chatId: string): Promise<ChatMessage | null> {
    const [next] = order(await this.inbox.pending(chatId));
    return next ? this.promote(next) : null;
  }

  /** Startup recovery: promote inputs left admitted by a crash, chat by chat. */
  async recover(): Promise<ChatMessage[]> {
    const chatIds = new Set((await this.inbox.allPending()).map((item) => item.chatId));
    const batches = await Promise.all([...chatIds].map((chatId) => this.drain(chatId)));
    return batches.flat();
  }

  /** The inbox row and the history row change together, so a crash cannot leave one without the other. */
  private promote(item: ChatInboxItem): Promise<ChatMessage> {
    return this.deps.db.transaction(async (tx) => {
      const message = await new ChatMessageRepository(tx).append(item.chatId, {
        id: item.messageId,
        role: "user",
        kind: item.mode,
        content: item.text,
      });
      await new ChatInboxRepository(tx).promote(item.chatId, item.messageId);
      return message;
    });
  }
}

function order(items: ChatInboxItem[]): ChatInboxItem[] {
  return [
    ...items.filter((item) => item.mode === "steer"),
    ...items.filter((item) => item.mode === "followup"),
  ];
}
