import { getRendererHandlers, tipc } from '@egoist/tipc/main';
import type { WebContents } from 'electron';
import type {
  ApiResult,
  CreatedInvite,
  CreateInviteInput,
  Meeting,
  MeetingInvite,
  MeetingMember,
  StartMeetingInput,
} from '../../types/transcript';
import { BackendApiError } from '../services/backend-api.client';
import type { DeepLinkInbox } from '../services/deep-link-inbox';
import type { MeetingService } from '../services/meeting.service';
import type { TranscriptRendererHandlers } from './transcript.handlers';

const t = tipc.create();

function failure(error: unknown): { error: string; status?: number; meetingId?: string } {
  if (error instanceof BackendApiError) {
    return {
      error: error.message,
      ...(error.status !== null ? { status: error.status } : {}),
      ...(error.meetingId ? { meetingId: error.meetingId } : {}),
    };
  }
  return { error: error instanceof Error ? error.message : String(error) };
}

export function createTranscriptRouter(service: MeetingService, deepLinks: DeepLinkInbox) {
  // Each window that calls in gets the transcript events pushed to it, once.
  const attached = new Map<number, () => void>();
  const attach = (sender: WebContents) => {
    if (attached.has(sender.id)) return;
    const handlers = getRendererHandlers<TranscriptRendererHandlers>(sender);
    const detach = service.onEvent((message) => {
      if (sender.isDestroyed()) return;
      switch (message.type) {
        case 'segment':
          handlers.onTranscriptSegment.send(message.event);
          break;
        case 'status':
          handlers.onTranscriptStatus.send(message.event);
          break;
        case 'reset':
          handlers.onTranscriptReset.send(message.event);
          break;
        case 'meeting':
          handlers.onMeetingChanged.send(message.event);
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
    transcriptConfigure: t.procedure
      .input<{ backendUrl: string }>()
      .action(async ({ input }): Promise<ApiResult<{ url: string }>> => {
        try {
          return { url: service.configure(input.backendUrl) };
        } catch (error) {
          return failure(error);
        }
      }),

    transcriptHealth: t.procedure.action(async (): Promise<ApiResult<{ ok: true }>> => {
      try {
        await service.health();
        return { ok: true };
      } catch (error) {
        return failure(error);
      }
    }),

    meetingList: t.procedure.action(async ({ context }): Promise<ApiResult<{ meetings: Meeting[] }>> => {
      attach(context.sender);
      try {
        return { meetings: await service.list() };
      } catch (error) {
        return failure(error);
      }
    }),

    /** The meeting being followed, so a reloaded window can pick it up again. */
    meetingActive: t.procedure.action(
      async ({ context }): Promise<{ meeting: Meeting | null; owned: boolean; speaking: boolean }> => {
        attach(context.sender);
        return { meeting: service.activeMeeting, owned: service.activeIsOwned, speaking: service.activeIsSpeaking };
      },
    ),

    meetingStart: t.procedure
      .input<StartMeetingInput>()
      .action(async ({ input, context }): Promise<ApiResult<{ meeting: Meeting }>> => {
        attach(context.sender);
        try {
          return { meeting: await service.start(input) };
        } catch (error) {
          return failure(error);
        }
      }),

    meetingEnd: t.procedure
      .input<{ meetingId: string }>()
      .action(async ({ input }): Promise<ApiResult<{ meeting: Meeting }>> => {
        try {
          return { meeting: await service.end(input.meetingId) };
        } catch (error) {
          return failure(error);
        }
      }),

    transcriptSubscribe: t.procedure
      .input<{ meetingId: string }>()
      .action(async ({ input, context }): Promise<ApiResult<{ meeting: Meeting }>> => {
        attach(context.sender);
        try {
          return { meeting: await service.subscribe(input.meetingId) };
        } catch (error) {
          return failure(error);
        }
      }),

    /** Joins a meeting through an invite link's token; `speak` also sends this app's microphone into it. */
    meetingJoin: t.procedure
      .input<{ token: string; speak: boolean }>()
      .action(async ({ input, context }): Promise<ApiResult<{ meeting: Meeting }>> => {
        attach(context.sender);
        try {
          return { meeting: await service.join(input.token, input.speak) };
        } catch (error) {
          return failure(error);
        }
      }),

    meetingLeave: t.procedure
      .input<{ meetingId: string }>()
      .action(async ({ input }): Promise<ApiResult<{ ok: true }>> => {
        try {
          await service.leave(input.meetingId);
          return { ok: true };
        } catch (error) {
          return failure(error);
        }
      }),

    inviteCreate: t.procedure
      .input<{ meetingId: string } & CreateInviteInput>()
      .action(async ({ input }): Promise<ApiResult<{ invite: CreatedInvite }>> => {
        try {
          const { meetingId, ...options } = input;
          return { invite: await service.createInvite(meetingId, options) };
        } catch (error) {
          return failure(error);
        }
      }),

    inviteList: t.procedure
      .input<{ meetingId: string }>()
      .action(async ({ input }): Promise<ApiResult<{ invites: MeetingInvite[] }>> => {
        try {
          return { invites: await service.listInvites(input.meetingId) };
        } catch (error) {
          return failure(error);
        }
      }),

    inviteRevoke: t.procedure
      .input<{ meetingId: string; inviteId: string }>()
      .action(async ({ input }): Promise<ApiResult<{ ok: true }>> => {
        try {
          await service.revokeInvite(input.meetingId, input.inviteId);
          return { ok: true };
        } catch (error) {
          return failure(error);
        }
      }),

    memberList: t.procedure
      .input<{ meetingId: string }>()
      .action(async ({ input }): Promise<ApiResult<{ members: MeetingMember[] }>> => {
        try {
          return { members: await service.listMembers(input.meetingId) };
        } catch (error) {
          return failure(error);
        }
      }),

    memberRemove: t.procedure
      .input<{ meetingId: string; userId: string }>()
      .action(async ({ input }): Promise<ApiResult<{ ok: true }>> => {
        try {
          await service.removeMember(input.meetingId, input.userId);
          return { ok: true };
        } catch (error) {
          return failure(error);
        }
      }),

    /** The invite a clicked meeting link carried, once; null when none is waiting. */
    inviteLinkTake: t.procedure.action(async (): Promise<{ token: string | null }> => ({ token: deepLinks.take() })),

    transcriptUnsubscribe: t.procedure.action(async (): Promise<{ ok: true }> => {
      service.unsubscribe();
      return { ok: true };
    }),

    /** One chunk of microphone audio: 16 kHz mono 16-bit little-endian PCM. */
    meetingAudio: t.procedure
      .input<{ data: Uint8Array }>()
      .action(async ({ input }): Promise<{ accepted: boolean }> => ({
        accepted: service.sendAudio(input.data),
      })),
  });
}
