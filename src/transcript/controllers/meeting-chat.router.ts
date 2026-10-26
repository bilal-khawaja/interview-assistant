import { getRendererHandlers, tipc } from '@egoist/tipc/main';
import type { WebContents } from 'electron';
import type { BackendChat, SendChatMessageInput } from '../../types/meeting-chat';
import type { ApiResult } from '../../types/transcript';
import { BackendApiError } from '../services/backend-api.client';
import type { MeetingChatService } from '../services/meeting-chat.service';
import type { MeetingChatRendererHandlers } from './meeting-chat.handlers';

const t = tipc.create();

function failure(error: unknown): { error: string; status?: number } {
  if (error instanceof BackendApiError) {
    return { error: error.message, ...(error.status !== null ? { status: error.status } : {}) };
  }
  return { error: error instanceof Error ? error.message : String(error) };
}

export function createMeetingChatRouter(service: MeetingChatService) {
  // Each window that calls in gets the chat events pushed to it, once.
  const attached = new Map<number, () => void>();
  const attach = (sender: WebContents) => {
    if (attached.has(sender.id)) return;
    const handlers = getRendererHandlers<MeetingChatRendererHandlers>(sender);
    const detach = service.onEvent((message) => {
      if (sender.isDestroyed()) return;
      switch (message.type) {
        case 'message':
          handlers.onChatMessage.send(message.event);
          break;
        case 'status':
          handlers.onChatStatus.send(message.event);
          break;
        case 'reset':
          handlers.onChatReset.send(message.event);
          break;
      }
    });
    attached.set(sender.id, detach);
    sender.once('destroyed', () => {
      detach();
      attached.delete(sender.id);
    });
  };

  return t.router({
    meetingChatList: t.procedure
      .input<{ meetingId: string }>()
      .action(async ({ input, context }): Promise<ApiResult<{ chats: BackendChat[] }>> => {
        attach(context.sender);
        try {
          return { chats: await service.list(input.meetingId) };
        } catch (error) {
          return failure(error);
        }
      }),

    meetingChatCreate: t.procedure
      .input<{ meetingId: string; title?: string }>()
      .action(async ({ input, context }): Promise<ApiResult<{ chat: BackendChat }>> => {
        attach(context.sender);
        try {
          return { chat: await service.create(input.meetingId, input.title) };
        } catch (error) {
          return failure(error);
        }
      }),

    meetingChatSend: t.procedure
      .input<SendChatMessageInput>()
      .action(async ({ input }): Promise<ApiResult<{ created: boolean }>> => {
        try {
          return await service.send(input);
        } catch (error) {
          return failure(error);
        }
      }),

    meetingChatFollow: t.procedure
      .input<{ meetingId: string; chatId: string }>()
      .action(async ({ input, context }): Promise<{ ok: true }> => {
        attach(context.sender);
        service.follow(input.meetingId, input.chatId);
        return { ok: true };
      }),

    meetingChatUnfollow: t.procedure.input<{ chatId: string }>().action(async ({ input }): Promise<{ ok: true }> => {
      service.unfollow(input.chatId);
      return { ok: true };
    }),
  });
}
