import { authStore } from './auth-client';
import { switchChatTabsUser } from './chat-tabs-store';
import { meetingChatStore } from './meeting-chat-client';
import { startSession } from './session';
import { transcriptStore } from './transcript-client';

/**
 * Ties this window's stores to the signed-in account. Meeting state lives for the whole
 * window, so the root layout starts this once.
 */
export const startAppSession = () =>
  startSession(authStore, {
    configureBackend: () => transcriptStore.applyBackendUrl(),
    startMeetings: () => transcriptStore.init(),
    resetMeetings: () => transcriptStore.reset(),
    resetMeetingChats: () => meetingChatStore.reset(),
    switchChatTabs: switchChatTabsUser,
  });
