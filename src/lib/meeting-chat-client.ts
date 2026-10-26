import { useSyncExternalStore } from 'react';
import { meetingChatHandlers, tipcInvoker } from './tipc-client';
import { MeetingChatStore, type ChatEntry, type MeetingChatApi } from './meeting-chat-store';

const t = tipcInvoker.meetingChat;

const api: MeetingChatApi = {
  list: (meetingId) => t.meetingChatList({ meetingId }),
  create: (meetingId, title) => t.meetingChatCreate({ meetingId, title }),
  send: (input) => t.meetingChatSend(input),
  follow: (meetingId, chatId) => t.meetingChatFollow({ meetingId, chatId }),
  unfollow: (chatId) => t.meetingChatUnfollow({ chatId }),
  listen: (handlers) => {
    const stops = [
      meetingChatHandlers.onChatMessage.listen(handlers.onMessage),
      meetingChatHandlers.onChatStatus.listen(handlers.onStatus),
      meetingChatHandlers.onChatReset.listen(handlers.onReset),
    ];
    return () => stops.forEach((stop) => stop());
  },
};

/** The one meeting-chat store for this window. Open chats outlive page navigation. */
export const meetingChatStore = new MeetingChatStore(api);

/** One chat's state, or undefined while it is not open. */
export function useMeetingChat(chatId: string | undefined): ChatEntry | undefined {
  return useSyncExternalStore(meetingChatStore.subscribe, () =>
    chatId ? meetingChatStore.getState().chats[chatId] : undefined,
  );
}
