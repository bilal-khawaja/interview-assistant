import { userOf, type AuthStore } from './auth-store';

/** What changes with the signed-in account. Everything here is one person's data. */
export interface SessionTargets {
  /** Applies the saved backend address in the main process, before any call that needs it. */
  configureBackend(): Promise<unknown>;
  /** Connects the meeting state for the signed-in account. */
  startMeetings(): Promise<unknown>;
  /** Forgets meetings, transcript and chats held for the previous account; stops the microphone. */
  resetMeetings(): void;
  resetMeetingChats(): void;
  /** Swaps the locally saved chat tabs to this account's (or none). */
  switchChatTabs(userId: string | null): void;
}

/**
 * Ties the window's state to who is signed in: on every change of account the previous
 * account's data is dropped before the next one's is loaded, so two accounts on one device
 * never see each other's meetings, chats or tabs. Returns a function that stops it.
 */
export function startSession(auth: AuthStore, targets: SessionTargets): () => void {
  const stop = auth.onTransition((previous, next) => {
    const before = userOf(previous)?.id ?? null;
    const after = userOf(next)?.id ?? null;
    if (before === after) return;
    if (before !== null) {
      targets.resetMeetings();
      targets.resetMeetingChats();
    }
    targets.switchChatTabs(after);
    if (after !== null) void targets.startMeetings();
  });
  // The address must be known to the main process before the saved session is checked.
  void targets.configureBackend().finally(() => void auth.init());
  return () => {
    stop();
    auth.dispose();
  };
}
