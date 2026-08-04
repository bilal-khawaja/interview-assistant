import { create } from 'zustand';
import { persist, type StateStorage } from 'zustand/middleware';
import type { ChatMessage } from '@/types/chat-message.model';

export interface ChatTab {
  id: string;
  title: string;
  messages: ChatMessage[];
  model: string;
  streamingText: string;
  streamingReasoning: string;
  isStreaming: boolean;
  error: string | null;
  createdAt: number;
}

interface ChatTabsState {
  tabs: ChatTab[];
  activeTabId: string | null;
  createTab: (model: string) => string;
  closeTab: (tabId: string) => void;
  setActiveTabId: (tabId: string) => void;
  appendUserMessage: (tabId: string, content: string) => void;
  appendStreamChunk: (tabId: string, type: 'text' | 'reasoning', delta: string) => void;
  finalizeStream: (tabId: string) => void;
  setNonStreamResult: (tabId: string, text: string, reasoning?: string) => void;
  setError: (tabId: string, message: string) => void;
  setStreaming: (tabId: string, isStreaming: boolean) => void;
  updateTabTitle: (tabId: string, title: string) => void;
  setModel: (tabId: string, model: string) => void;
}

const DEFAULT_TITLE = 'New chat';

function newTab(model: string): ChatTab {
  return {
    id: crypto.randomUUID(),
    title: DEFAULT_TITLE,
    messages: [],
    model,
    streamingText: '',
    streamingReasoning: '',
    isStreaming: false,
    error: null,
    createdAt: Date.now(),
  };
}

let isAnyStreaming = false;
let pendingWrite: { key: string; value: string } | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

const DEBOUNCE_MS = 300;

const throttledStorage: StateStorage = {
  getItem: (name) => localStorage.getItem(name),
  removeItem: (name) => localStorage.removeItem(name),
  setItem: (name, value) => {
    pendingWrite = { key: name, value };
    if (isAnyStreaming) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flushPendingWrite, DEBOUNCE_MS);
  },
};

function flushPendingWrite() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (pendingWrite) {
    localStorage.setItem(pendingWrite.key, pendingWrite.value);
    pendingWrite = null;
  }
}

type PersistedChatTabsState = { tabs: ChatTab[]; activeTabId: string | null };

export const useChatTabsStore = create<ChatTabsState>()(
  persist<ChatTabsState, [], [], PersistedChatTabsState>(
    (set, get) => ({
      tabs: [],
      activeTabId: null,

      createTab: (model) => {
        const tab = newTab(model);
        set((state) => ({ tabs: [...state.tabs, tab], activeTabId: tab.id }));
        return tab.id;
      },

      closeTab: (tabId) => {
        set((state) => {
          const tabs = state.tabs.filter((t) => t.id !== tabId);
          const activeTabId =
            state.activeTabId === tabId ? (tabs[tabs.length - 1]?.id ?? null) : state.activeTabId;
          return { tabs, activeTabId };
        });
      },

      setActiveTabId: (tabId) => set({ activeTabId: tabId }),

      appendUserMessage: (tabId, content) => {
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === tabId
              ? { ...t, messages: [...t.messages, { role: 'user', content }], error: null }
              : t
          ),
        }));
      },

      appendStreamChunk: (tabId, type, delta) => {
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === tabId
              ? type === 'text'
                ? { ...t, streamingText: t.streamingText + delta }
                : { ...t, streamingReasoning: t.streamingReasoning + delta }
              : t
          ),
        }));
      },

      finalizeStream: (tabId) => {
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  messages: t.streamingText
                    ? [...t.messages, { role: 'assistant' as const, content: t.streamingText }]
                    : t.messages,
                  streamingText: '',
                  streamingReasoning: '',
                  isStreaming: false,
                }
              : t
          ),
        }));
        isAnyStreaming = get().tabs.some((t) => t.isStreaming);
        if (!isAnyStreaming) flushPendingWrite();
      },

      setNonStreamResult: (tabId, text, reasoning) => {
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  messages: [...t.messages, { role: 'assistant' as const, content: text }],
                  streamingReasoning: reasoning ?? '',
                  isStreaming: false,
                }
              : t
          ),
        }));
        isAnyStreaming = get().tabs.some((t) => t.isStreaming);
        if (!isAnyStreaming) flushPendingWrite();
      },

      setError: (tabId, message) => {
        set((state) => ({
          tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, error: message, isStreaming: false } : t)),
        }));
        isAnyStreaming = get().tabs.some((t) => t.isStreaming);
        if (!isAnyStreaming) flushPendingWrite();
      },

      setStreaming: (tabId, streaming) => {
        set((state) => ({
          tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, isStreaming: streaming } : t)),
        }));
        isAnyStreaming = get().tabs.some((t) => t.isStreaming);
      },

      updateTabTitle: (tabId, title) => {
        set((state) => ({
          tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, title } : t)),
        }));
      },

      setModel: (tabId, model) => {
        set((state) => ({
          tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, model } : t)),
        }));
      },
    }),
    {
      name: 'ai.chatTabs',
      storage: {
        getItem: (name) => {
          const value = throttledStorage.getItem(name) as string | null;
          return value ? JSON.parse(value) : null;
        },
        setItem: (name, value) => throttledStorage.setItem(name, JSON.stringify(value)),
        removeItem: (name) => throttledStorage.removeItem(name),
      },
      partialize: (state) => ({
        tabs: state.tabs.map((t) => ({ ...t, streamingText: '', streamingReasoning: '', isStreaming: false })),
        activeTabId: state.activeTabId,
      }),
    }
  )
);

export const DEFAULT_TAB_TITLE = DEFAULT_TITLE;
