import type { ChatMessageEvent, ChatResetEvent, ChatStatusEvent } from '../../types/meeting-chat';

/**
 * Main -> renderer push events for the open meeting chats.
 * Shared type between the main-process sender and the renderer listener.
 */
export type MeetingChatRendererHandlers = {
  onChatMessage: (data: ChatMessageEvent) => void;
  onChatStatus: (data: ChatStatusEvent) => void;
  onChatReset: (data: ChatResetEvent) => void;
};
