import type { Meeting } from '../types/transcript';
import { useChatTabsStore } from './chat-tabs-store';
import { meetingChatStore } from './meeting-chat-client';

/** What a new chat tab for the meeting is called. */
export function meetingChatTabTitle(meeting: Meeting): string {
  return `${meeting.title.trim() || 'Meeting'} chat`;
}

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

/** Closes a tab, and for a meeting chat stops following it. The chat stays on the backend. */
export function closeChatTab(tabId: string): void {
  const tab = useChatTabsStore.getState().tabs.find((t) => t.id === tabId);
  if (tab?.type === 'meeting' && tab.chatId) void meetingChatStore.close(tab.chatId);
  useChatTabsStore.getState().closeTab(tabId);
}
