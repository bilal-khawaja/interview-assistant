import { inviteInbox } from './invite-inbox';
import { tipcInvoker, transcriptHandlers } from './tipc-client';

/**
 * Feeds meeting links the operating system opened into the invite inbox: one pushed while the
 * window is up, and one that was waiting when it started. Returns the stop function.
 */
export function startInviteLinks(): () => void {
    const take = () =>
        void tipcInvoker.transcript
            .inviteLinkTake()
            .then(({ token }) => {
                if (token) inviteInbox.set(token);
            })
            .catch(() => undefined);
    // The push carries the token, but taking it also empties the main process's copy.
    const stop = transcriptHandlers.onInviteLink.listen(({ token }) => {
        inviteInbox.set(token);
        take();
    });
    take();
    return stop;
}
