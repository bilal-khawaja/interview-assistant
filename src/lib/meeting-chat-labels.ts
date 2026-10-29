import type { BackendChat } from '../types/meeting-chat';
import type { Meeting } from '../types/transcript';

/** What a new chat tab for the meeting is called. */
export function meetingChatTabTitle(meeting: Pick<Meeting, 'title'>): string {
  return `${meeting.title.trim() || 'Meeting'} chat`;
}

/** The tab title for an existing chat: its own title, else the meeting's with the time it was made. */
export function existingChatTabTitle(chat: BackendChat, meeting: Pick<Meeting, 'title'>): string {
  return chat.title.trim() || `${meetingChatTabTitle(meeting)} ${formatChatTime(chat.createdAt)}`.trim();
}

export function formatChatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export interface OpenableChat {
  chat: BackendChat;
  label: string;
  /** This device already has a tab for it, so choosing it just brings the tab forward. */
  open: boolean;
}

/**
 * The meeting's chats for the "Open chat" list: oldest first, so the chat made when the
 * meeting started leads, each marked if this device already shows it.
 */
export function openableChats(
  chats: BackendChat[],
  meeting: Pick<Meeting, 'title'>,
  openChatIds: ReadonlySet<string>,
): OpenableChat[] {
  return [...chats]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((chat) => ({ chat, label: existingChatTabTitle(chat, meeting), open: openChatIds.has(chat.id) }));
}
