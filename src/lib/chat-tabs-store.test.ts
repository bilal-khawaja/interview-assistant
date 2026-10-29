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
let switchChatTabsUser: typeof import('./chat-tabs-store').switchChatTabsUser;

beforeAll(async () => {
  ({ useChatTabsStore, switchChatTabsUser } = await import('./chat-tabs-store'));
  switchChatTabsUser('u1'); // tabs are saved per account
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
    const stored = JSON.parse(saved.get('ai.chatTabs:u1') ?? 'null') as {
      state: { tabs: { type: string; meetingId?: string; chatId?: string; title: string }[] };
    };
    expect(stored.state.tabs.find((t) => t.type === 'meeting')).toMatchObject({
      meetingId: 'm1',
      chatId: 'c1',
      title: 'saved',
    });
  });
});

describe('tabs per account', () => {
  const stored = (user: string) =>
    JSON.parse(saved.get(`ai.chatTabs:${user}`) ?? 'null') as { state: { tabs: { title: string }[] } } | null;
  const titles = () => state().tabs.map((t) => t.title);

  beforeEach(() => {
    for (const key of [...saved.keys()]) saved.delete(key);
    switchChatTabsUser(null);
  });

  test('each account gets its own tabs back after another account used the device', () => {
    switchChatTabsUser('ada');
    state().createMeetingTab('m1', 'c1', 'ada chat');
    switchChatTabsUser('bo');
    expect(state().tabs).toEqual([]);
    state().createMeetingTab('m2', 'c2', 'bo chat');

    switchChatTabsUser('ada');
    expect(titles()).toEqual(['ada chat']);
    switchChatTabsUser('bo');
    expect(titles()).toEqual(['bo chat']);
  });

  test('the previous account\'s tabs are saved under that account even if the write was still queued', () => {
    switchChatTabsUser('ada');
    state().createMeetingTab('m1', 'c1', 'queued');
    switchChatTabsUser('bo'); // switches before the debounced write would have run
    expect(stored('ada')?.state.tabs.map((t) => t.title)).toEqual(['queued']);
    expect(stored('bo')?.state.tabs ?? []).toEqual([]);
  });

  test('signed out there are no tabs, and nothing is written for anyone', () => {
    switchChatTabsUser('ada');
    state().createMeetingTab('m1', 'c1', 'mine');
    switchChatTabsUser(null);
    expect(state().tabs).toEqual([]);
    state().createTab('some-model'); // e.g. a stray action while signed out
    switchChatTabsUser('ada');
    expect(titles()).toEqual(['mine']);
    expect([...saved.keys()].filter((key) => !key.startsWith('ai.chatTabs:'))).toEqual([]);
  });

  test('the first account on a device inherits the tabs saved before accounts existed; later accounts do not', () => {
    const legacy = {
      state: {
        tabs: [
          {
            id: 't1',
            type: 'meeting',
            title: 'old chat',
            messages: [],
            model: '',
            streamingText: '',
            streamingReasoning: '',
            isStreaming: false,
            error: null,
            createdAt: 1,
            meetingId: 'm1',
            chatId: 'c1',
          },
        ],
        activeTabId: 't1',
      },
      version: 0,
    };
    saved.set('ai.chatTabs', JSON.stringify(legacy));

    switchChatTabsUser('first');
    expect(titles()).toEqual(['old chat']);
    expect(saved.has('ai.chatTabs')).toBe(false);

    switchChatTabsUser('second');
    expect(state().tabs).toEqual([]);
    switchChatTabsUser('first');
    expect(titles()).toEqual(['old chat']);
  });

  test('an account that already has saved tabs keeps them when the old shared copy is found', () => {
    switchChatTabsUser('ada');
    state().createMeetingTab('m1', 'c1', 'current');
    switchChatTabsUser(null);
    saved.set('ai.chatTabs', JSON.stringify({ state: { tabs: [], activeTabId: null }, version: 0 }));
    switchChatTabsUser('ada');
    expect(titles()).toEqual(['current']);
    expect(saved.has('ai.chatTabs')).toBe(false);
  });
});
