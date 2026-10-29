import type {
  BackendChat,
  BackendChatKind,
  BackendChatMessage,
  ChatMessageEvent,
  ChatResetEvent,
  ChatStatusEvent,
  ChatStreamStatus,
  SendChatMessageInput,
  SendMode,
} from '../types/meeting-chat';
import type { ApiResult } from '../types/transcript';

/** What the store needs from the main process. The app wires this to tipc. */
export interface MeetingChatApi {
  list(meetingId: string): Promise<ApiResult<{ chats: BackendChat[] }>>;
  create(meetingId: string, title?: string): Promise<ApiResult<{ chat: BackendChat }>>;
  send(input: SendChatMessageInput): Promise<ApiResult<{ created: boolean }>>;
  follow(meetingId: string, chatId: string): Promise<unknown>;
  unfollow(chatId: string): Promise<unknown>;
  listen(handlers: {
    onMessage: (e: ChatMessageEvent) => void;
    onStatus: (e: ChatStatusEvent) => void;
    onReset: (e: ChatResetEvent) => void;
  }): () => void;
}

/**
 * A message the user sees. Suggestions and the backend's internal summaries never become one:
 * the chat shows what the user said and what the assistant answered.
 */
export interface ChatViewMessage {
  id: string;
  /** Null until the backend has stored the message and echoed it back. */
  seq: number | null;
  role: 'user' | 'assistant' | 'system';
  kind: BackendChatKind;
  content: string;
  createdAt: string;
  /** Where the message is on its way to the backend. Anything the backend sent is "sent". */
  delivery: 'sending' | 'sent' | 'failed';
}

export interface ChatEntry {
  chatId: string;
  meetingId: string;
  /** Oldest first: stored messages by seq, then the user's own messages still on their way. */
  messages: ChatViewMessage[];
  status: ChatStreamStatus | null;
  detail: string | null;
  /** The newest message is the user's, so an answer is still expected. */
  pending: boolean;
  /** Why the last send failed. Cleared by the next send. */
  error: string | null;
}

export interface MeetingChatsState {
  chats: Record<string, ChatEntry>;
}

/** Kinds the user never sees. */
const HIDDEN_KINDS: readonly BackendChatKind[] = ['suggestion', 'summary'];

function isVisible(message: BackendChatMessage): boolean {
  return !HIDDEN_KINDS.includes(message.kind) && message.role !== 'summary';
}

function derivePending(messages: ChatViewMessage[]): boolean {
  return messages.at(-1)?.role === 'user' && messages.at(-1)?.delivery !== 'failed';
}

function withMessages(entry: ChatEntry, messages: ChatViewMessage[], patch: Partial<ChatEntry> = {}): ChatEntry {
  return { ...entry, ...patch, messages, pending: derivePending(messages) };
}

export class MeetingChatStore {
  private state: MeetingChatsState = { chats: {} };
  private readonly subscribers = new Set<() => void>();
  /** Highest seq seen per chat, hidden messages included, so repeats are dropped. */
  private readonly lastSeq = new Map<string, number>();
  /** What each unsent or unconfirmed message needs to be sent again. */
  private readonly outgoing = new Map<string, { chatId: string; text: string; mode: SendMode }>();
  private unlisten: (() => void) | null = null;

  constructor(
    private readonly api: MeetingChatApi,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  // --- external store contract (useSyncExternalStore) ---

  subscribe = (listener: () => void): (() => void) => {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  };

  getState = (): MeetingChatsState => this.state;

  private set(state: MeetingChatsState): void {
    this.state = state;
    for (const listener of this.subscribers) listener();
  }

  private update(chatId: string, change: (entry: ChatEntry) => ChatEntry): void {
    const entry = this.state.chats[chatId];
    if (!entry) return;
    this.set({ chats: { ...this.state.chats, [chatId]: change(entry) } });
  }

  // --- lifecycle ---

  /** Starts listening to the main process. Safe to call repeatedly. */
  init(): void {
    if (this.unlisten) return;
    this.unlisten = this.api.listen({
      onMessage: (e) => this.onMessage(e),
      onStatus: (e) => this.onStatus(e),
      onReset: (e) => this.onReset(e),
    });
  }

  dispose(): void {
    this.unlisten?.();
    this.unlisten = null;
  }

  /** Forgets every open chat (sign-out, or another account signing in). The main process stops the streams. */
  reset(): void {
    this.lastSeq.clear();
    this.outgoing.clear();
    this.set({ chats: {} });
  }

  listChats(meetingId: string): Promise<ApiResult<{ chats: BackendChat[] }>> {
    return this.api.list(meetingId);
  }

  /** Creates a chat on the backend and opens it. */
  async createChat(meetingId: string, title = ''): Promise<ApiResult<{ chat: BackendChat }>> {
    const result = await this.api.create(meetingId, title);
    if (result.error === undefined) await this.open(meetingId, result.chat.id);
    return result;
  }

  /**
   * Starts following a chat: its history arrives first, then new messages. Opening a chat that
   * is already open follows it again, which refreshes it without duplicating anything.
   */
  async open(meetingId: string, chatId: string): Promise<void> {
    this.init();
    if (!this.state.chats[chatId]) {
      const entry: ChatEntry = {
        chatId,
        meetingId,
        messages: [],
        status: null,
        detail: null,
        pending: false,
        error: null,
      };
      this.set({ chats: { ...this.state.chats, [chatId]: entry } });
    }
    await this.api.follow(meetingId, chatId);
  }

  /** Stops following and forgets the chat. The chat itself stays on the backend. */
  async close(chatId: string): Promise<void> {
    const { [chatId]: _gone, ...rest } = this.state.chats;
    this.lastSeq.delete(chatId);
    for (const [messageId, sent] of this.outgoing) if (sent.chatId === chatId) this.outgoing.delete(messageId);
    this.set({ chats: rest });
    await this.api.unfollow(chatId);
  }

  // --- sending ---

  /** Shows the message at once, then sends it. The answer arrives as a message event. */
  async send(chatId: string, text: string, mode: SendMode = 'followup'): Promise<void> {
    const body = text.trim();
    if (!body || !this.state.chats[chatId]) return;
    const messageId = this.newId();
    this.outgoing.set(messageId, { chatId, text: body, mode });
    this.update(chatId, (entry) =>
      withMessages(
        entry,
        [
          ...entry.messages,
          {
            id: messageId,
            seq: null,
            role: 'user',
            kind: mode,
            content: body,
            createdAt: new Date().toISOString(),
            delivery: 'sending',
          },
        ],
        { error: null },
      ),
    );
    await this.transmit(messageId);
  }

  /** Sends a failed message again. The backend ignores it if it had arrived after all. */
  async retry(chatId: string, messageId: string): Promise<void> {
    const entry = this.state.chats[chatId];
    if (!entry?.messages.some((m) => m.id === messageId && m.delivery === 'failed')) return;
    this.update(chatId, (current) =>
      withMessages(
        current,
        current.messages.map((m) => (m.id === messageId ? { ...m, delivery: 'sending' as const } : m)),
        { error: null },
      ),
    );
    await this.transmit(messageId);
  }

  private async transmit(messageId: string): Promise<void> {
    const sent = this.outgoing.get(messageId);
    if (!sent) return;
    const entry = this.state.chats[sent.chatId];
    if (!entry) return;
    const result = await this.api.send({
      meetingId: entry.meetingId,
      chatId: sent.chatId,
      messageId,
      text: sent.text,
      mode: sent.mode,
    });
    if (result.error !== undefined) {
      this.update(sent.chatId, (current) =>
        withMessages(
          current,
          current.messages.map((m) => (m.id === messageId && m.seq === null ? { ...m, delivery: 'failed' as const } : m)),
          { error: result.error },
        ),
      );
      return;
    }
    this.outgoing.delete(messageId);
    this.update(sent.chatId, (current) =>
      withMessages(
        current,
        current.messages.map((m) => (m.id === messageId && m.delivery === 'sending' ? { ...m, delivery: 'sent' as const } : m)),
      ),
    );
  }

  // --- events from the main process ---

  private onMessage({ chatId, message }: ChatMessageEvent): void {
    const entry = this.state.chats[chatId];
    if (!entry) return;
    if (message.seq <= (this.lastSeq.get(chatId) ?? 0)) return;
    this.lastSeq.set(chatId, message.seq);
    this.outgoing.delete(message.id);
    // A hidden message still counts as seen above; it just never reaches the screen.
    if (!isVisible(message)) return;
    const shown: ChatViewMessage = {
      id: message.id,
      seq: message.seq,
      role: message.role === 'summary' ? 'system' : message.role,
      kind: message.kind,
      content: message.content,
      createdAt: message.createdAt,
      delivery: 'sent',
    };
    this.update(chatId, (current) => {
      const rest = current.messages.filter((m) => m.id !== message.id);
      const firstOutgoing = rest.findIndex((m) => m.seq === null);
      const at = firstOutgoing === -1 ? rest.length : firstOutgoing;
      return withMessages(current, [...rest.slice(0, at), shown, ...rest.slice(at)]);
    });
  }

  private onStatus({ chatId, status, detail }: ChatStatusEvent): void {
    this.update(chatId, (entry) => ({ ...entry, status, detail: detail ?? null }));
  }

  /** The backend's log is behind ours: what we hold is stale. The stream replays from zero. */
  private onReset({ chatId }: ChatResetEvent): void {
    this.lastSeq.delete(chatId);
    this.update(chatId, (entry) => withMessages(entry, entry.messages.filter((m) => m.seq === null)));
  }
}
