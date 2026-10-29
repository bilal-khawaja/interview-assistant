import type {
  BackendChat,
  ChatMessageEvent,
  ChatResetEvent,
  ChatStatusEvent,
  SendChatMessageInput,
} from '../../types/meeting-chat';
import type { BackendApi } from './backend-api.client';
import { ChatStreamClient, type ChatStreamClientOptions } from './chat-stream.client';

export type MeetingChatEvent =
  | { type: 'message'; event: ChatMessageEvent }
  | { type: 'status'; event: ChatStatusEvent }
  | { type: 'reset'; event: ChatResetEvent };

export interface MeetingChatServiceOptions {
  streamOptions?: Partial<ChatStreamClientOptions>;
}

/**
 * The app's side of a meeting's chats: lists and creates them on the backend, posts messages,
 * and follows each open chat's message stream. Any number of chats can be open at once.
 * Everything the renderer needs is pushed through listeners as plain events.
 */
export class MeetingChatService {
  private readonly open = new Map<string, ChatStreamClient>();
  private readonly listeners = new Set<(event: MeetingChatEvent) => void>();

  constructor(
    private readonly api: BackendApi,
    private readonly options: MeetingChatServiceOptions = {},
  ) {}

  onEvent(listener: (event: MeetingChatEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(meetingId: string): Promise<BackendChat[]> {
    return this.api.listChats(meetingId);
  }

  create(meetingId: string, title = ''): Promise<BackendChat> {
    return this.api.createChat(meetingId, title);
  }

  /** The reply is not returned: it arrives as a message event once the backend has written it. */
  async send(input: SendChatMessageInput): Promise<{ created: boolean }> {
    const { created } = await this.api.postChatMessage(input.meetingId, input.chatId, {
      messageId: input.messageId,
      text: input.text,
      mode: input.mode ?? 'followup',
    });
    return { created };
  }

  /**
   * Follows the chat's messages from the first one. Following a chat that is already followed
   * starts it over, so a reloaded window gets the history again; the renderer drops repeats.
   */
  follow(meetingId: string, chatId: string): void {
    this.unfollow(chatId);
    const stream = new ChatStreamClient({
      baseUrl: this.api.url,
      meetingId,
      chatId,
      onMessage: (message) => this.emit({ type: 'message', event: { chatId, message } }),
      onStatus: (status, detail) => this.emit({ type: 'status', event: { chatId, status, detail } }),
      onReset: () => this.emit({ type: 'reset', event: { chatId } }),
      createSocket: this.api.openSocket,
      ...this.options.streamOptions,
    });
    this.open.set(chatId, stream);
    stream.start();
  }

  unfollow(chatId: string): void {
    this.open.get(chatId)?.stop();
    this.open.delete(chatId);
  }

  /** Stops every open chat stream, e.g. when the account signs out. */
  unfollowAll(): void {
    for (const stream of this.open.values()) stream.stop();
    this.open.clear();
  }

  dispose(): void {
    this.unfollowAll();
    this.listeners.clear();
  }

  private emit(event: MeetingChatEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a dead window must not break delivery to the others
      }
    }
  }
}
