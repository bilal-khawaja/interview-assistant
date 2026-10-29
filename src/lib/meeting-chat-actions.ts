import type { BackendChat } from '../types/meeting-chat';
import type { Meeting } from '../types/transcript';
import { useChatTabsStore } from './chat-tabs-store';
import { meetingChatStore } from './meeting-chat-client';
import { existingChatTabTitle, meetingChatTabTitle } from './meeting-chat-labels';

export { meetingChatTabTitle };

/**
 * Creates a new chat on the meeting's backend and opens it as a tab in /ai.
 * Resolves to an error message, or null when the tab is open and active.
 */
export async function startMeetingChat(meeting: Meeting): Promise<string | null> {
  const result = await meetingChatStore.createChat(meeting.id);
  if (result.error !== undefined) return result.error;
  useChatTabsStore.getState().createMeetingTab(meeting.id, result.chat.id, meetingChatTabTitle(meeting));
  return null;
}

/**
 * Opens a chat that already exists on the backend, e.g. one made on another device, as a tab
 * in /ai. Its history arrives first, then new messages. A chat this device already shows is
 * just brought forward.
 */
export function openExistingChat(meeting: Meeting, chat: BackendChat): void {
  useChatTabsStore.getState().createMeetingTab(meeting.id, chat.id, existingChatTabTitle(chat, meeting));
}

/** Ids of the backend chats this device has a tab for. */
export function openChatIds(): Set<string> {
  const ids = new Set<string>();
  for (const tab of useChatTabsStore.getState().tabs) if (tab.type === 'meeting' && tab.chatId) ids.add(tab.chatId);
  return ids;
}

/** Closes a tab, and for a meeting chat stops following it. The chat stays on the backend. */
export function closeChatTab(tabId: string): void {
  const tab = useChatTabsStore.getState().tabs.find((t) => t.id === tabId);
  if (tab?.type === 'meeting' && tab.chatId) void meetingChatStore.close(tab.chatId);
  useChatTabsStore.getState().closeTab(tabId);
}
