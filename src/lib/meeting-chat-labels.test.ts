import { describe, expect, test } from 'bun:test';
import type { BackendChat } from '../types/meeting-chat';
import { existingChatTabTitle, meetingChatTabTitle, openableChats } from './meeting-chat-labels';

const chat = (id: string, createdAt: string, title = ''): BackendChat => ({ id, meetingId: 'm1', title, createdAt });
const meeting = { title: 'Standup' };

describe('chat labels', () => {
  test('a new chat tab is named after the meeting, with a fallback for an untitled one', () => {
    expect(meetingChatTabTitle(meeting)).toBe('Standup chat');
    expect(meetingChatTabTitle({ title: '  ' })).toBe('Meeting chat');
  });

  test('an existing chat keeps its own title', () => {
    expect(existingChatTabTitle(chat('c1', '2026-01-01T10:00:00Z', 'Interview prep'), meeting)).toBe('Interview prep');
  });

  test('an untitled chat is told apart by when it was made', () => {
    const title = existingChatTabTitle(chat('c1', '2026-01-01T10:00:00Z'), meeting);
    expect(title.startsWith('Standup chat')).toBe(true);
    expect(title.length).toBeGreaterThan('Standup chat'.length);
  });

  test('a chat with an unreadable time still gets a title', () => {
    expect(existingChatTabTitle(chat('c1', 'not a date'), meeting)).toBe('Standup chat');
  });
});

describe('openableChats', () => {
  const chats = [
    chat('late', '2026-01-01T12:00:00Z', 'Later'),
    chat('first', '2026-01-01T10:00:00Z', 'Made at the start'),
    chat('mid', '2026-01-01T11:00:00Z'),
  ];

  test('lists the chats oldest first, so the one made when the meeting started leads', () => {
    expect(openableChats(chats, meeting, new Set()).map((c) => c.chat.id)).toEqual(['first', 'mid', 'late']);
  });

  test('marks the chats this device already has a tab for', () => {
    const marked = openableChats(chats, meeting, new Set(['mid']));
    expect(marked.map((c) => [c.chat.id, c.open])).toEqual([
      ['first', false],
      ['mid', true],
      ['late', false],
    ]);
  });

  test('does not reorder or change the list it was given', () => {
    const before = chats.map((c) => c.id);
    openableChats(chats, meeting, new Set());
    expect(chats.map((c) => c.id)).toEqual(before);
  });

  test('a meeting with no chats gives an empty list', () => {
    expect(openableChats([], meeting, new Set())).toEqual([]);
  });
});
