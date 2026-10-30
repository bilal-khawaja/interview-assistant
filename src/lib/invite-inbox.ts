import { useSyncExternalStore } from 'react';
import { INVITE_LINK_PREFIX } from './invite-link';

/**
 * The invite from a clicked meeting link, held until the Meetings page offers it to the person.
 * It survives the sign-in screen: a link opened while signed out is kept, and handled once the
 * account is in.
 */
export class InviteInbox {
  private token: string | null = null;
  private readonly subscribers = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  };

  /** The waiting invite as a link, or null. */
  getSnapshot = (): string | null => (this.token === null ? null : `${INVITE_LINK_PREFIX}${this.token}`);

  set(token: string): void {
    this.token = token;
    for (const listener of this.subscribers) listener();
  }

  clear(): void {
    if (this.token === null) return;
    this.token = null;
    for (const listener of this.subscribers) listener();
  }
}

export const inviteInbox = new InviteInbox();

export function usePendingInvite(): string | null {
  return useSyncExternalStore(inviteInbox.subscribe, inviteInbox.getSnapshot);
}
