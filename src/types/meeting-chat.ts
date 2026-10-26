// Wire types shared with backend/server (src/server/frames.ts and chat-routes.ts).
// Copied rather than imported so the Electron build never reaches into backend/.

export type BackendChatRole = 'user' | 'assistant' | 'system' | 'summary';

/**
 * steer / followup: how a user message was admitted. suggestion: unprompted assistant output
 * driven by the transcript. reply: the answer to a user message. notice: a system line.
 */
export type BackendChatKind = 'steer' | 'followup' | 'suggestion' | 'reply' | 'notice' | 'summary';

/** How a message is queued while the chat is busy: a steer stops the turn in flight. */
export type SendMode = 'steer' | 'followup';

export interface BackendChat {
  id: string;
  meetingId: string;
  title: string;
  createdAt: string;
}

/** One chat message, as stored. seq is gapless per chat, so a stream resumes with ?after=<last seq>. */
export interface BackendChatMessage {
  id: string;
  seq: number;
  role: BackendChatRole;
  kind: BackendChatKind;
  content: string;
  /** The transcript line the chat had reached when the message was written, if any. */
  transcriptSeq: number | null;
  createdAt: string;
}

/** Connection state of one chat's message stream. Same meaning as StreamStatus, minus "ended". */
export type ChatStreamStatus = 'connecting' | 'live' | 'degraded' | 'reconnecting';

export interface ChatMessageEvent {
  chatId: string;
  message: BackendChatMessage;
}

export interface ChatStatusEvent {
  chatId: string;
  status: ChatStreamStatus;
  detail?: string;
}

/** The chat's sequence restarted from zero (the server is behind the client's cursor); clear what you hold. */
export interface ChatResetEvent {
  chatId: string;
}

export interface SendChatMessageInput {
  meetingId: string;
  chatId: string;
  /** The client's id for this message. Sending the same id again never creates a second message. */
  messageId: string;
  text: string;
  mode?: SendMode;
}
