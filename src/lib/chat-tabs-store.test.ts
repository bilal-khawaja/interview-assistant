import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';

// The store reads localStorage when it is created, so it has to exist first.
const saved = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => void saved.set(key, value),
    removeItem: (key: string) => void saved.delete(key),
  },
});

let useChatTabsStore: typeof import('./chat-tabs-store').useChatTabsStore;

beforeAll(async () => {
  ({ useChatTabsStore } = await import('./chat-tabs-store'));
});

beforeEach(() => {
  useChatTabsStore.setState({ tabs: [], activeTabId: null, pinnedTabId: null });
});

const state = () => useChatTabsStore.getState();

describe('meeting tabs', () => {
  test('a meeting chat opens as an active tab that carries its meeting and chat ids', () => {
    const id = state().createMeetingTab('m1', 'c1', 'Standup chat');
    expect(state().activeTabId).toBe(id);
    expect(state().tabs).toHaveLength(1);
    expect(state().tabs[0]).toMatchObject({
      type: 'meeting',
      title: 'Standup chat',
      meetingId: 'm1',
      chatId: 'c1',
      messages: [],
    });
  });

  test('opening a chat that already has a tab brings that tab forward instead of adding another', () => {
    const first = state().createMeetingTab('m1', 'c1', 'one');
    state().createTab('gpt');
    const again = state().createMeetingTab('m1', 'c1', 'one');
    expect(again).toBe(first);
    expect(state().activeTabId).toBe(first);
    expect(state().tabs.filter((t) => t.type === 'meeting')).toHaveLength(1);
  });

  test('two chats of the same meeting get two tabs', () => {
    const a = state().createMeetingTab('m1', 'c1', 'a');
    const b = state().createMeetingTab('m1', 'c2', 'b');
    expect(a).not.toBe(b);
    expect(state().tabs.map((t) => t.chatId)).toEqual(['c1', 'c2']);
  });

  test('meeting tabs sit beside ordinary chats without disturbing them', () => {
    const chat = state().createTab('gpt');
    state().appendUserMessage(chat, 'hello');
    state().createMeetingTab('m1', 'c1', 'a');
    expect(state().tabs.find((t) => t.id === chat)?.messages).toHaveLength(1);
    state().closeTab(state().tabs.find((t) => t.type === 'meeting')!.id);
    expect(state().tabs.map((t) => t.id)).toEqual([chat]);
    expect(state().activeTabId).toBe(chat);
  });

  test('a meeting tab is saved with its ids so it can be reopened after a restart', async () => {
    state().createMeetingTab('m1', 'c1', 'saved');
    await new Promise((resolve) => setTimeout(resolve, 400)); // the store debounces its writes
    const stored = JSON.parse(saved.get('ai.chatTabs') ?? 'null') as {
      state: { tabs: { type: string; meetingId?: string; chatId?: string; title: string }[] };
    };
    expect(stored.state.tabs.find((t) => t.type === 'meeting')).toMatchObject({
      meetingId: 'm1',
      chatId: 'c1',
      title: 'saved',
    });
  });
});
