import { tipcInvoker } from './tipc-client';

const t = tipcInvoker.transcript;

/** The owner's side of a meeting's guest list: invite links and the people who joined through them. */
export const meetingAccess = {
    createInvite: (meetingId: string, options: { expiresInMinutes: number; maxUses?: number | null }) =>
        t.inviteCreate({ meetingId, ...options }),
    listInvites: (meetingId: string) => t.inviteList({ meetingId }),
    revokeInvite: (meetingId: string, inviteId: string) => t.inviteRevoke({ meetingId, inviteId }),
    listMembers: (meetingId: string) => t.memberList({ meetingId }),
    removeMember: (meetingId: string, userId: string) => t.memberRemove({ meetingId, userId }),
};
