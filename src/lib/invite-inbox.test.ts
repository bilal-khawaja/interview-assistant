import { describe, expect, test } from 'bun:test';
import { InviteInbox } from './invite-inbox';

const TOKEN = 'k3J9_aZx-0pQwErTyUiOpAsDfGhJkLzXcVbNm12345A';

describe('InviteInbox', () => {
  test('holds the invite as a join link until it is cleared', () => {
    const inbox = new InviteInbox();
    expect(inbox.getSnapshot()).toBeNull();
    inbox.set(TOKEN);
    expect(inbox.getSnapshot()).toBe(`interview-assistant://join/${TOKEN}`);
    inbox.clear();
    expect(inbox.getSnapshot()).toBeNull();
  });

  test('tells subscribers when it fills and empties, and not when clearing nothing', () => {
    const inbox = new InviteInbox();
    let calls = 0;
    const stop = inbox.subscribe(() => calls++);
    inbox.clear();
    expect(calls).toBe(0);
    inbox.set(TOKEN);
    inbox.clear();
    expect(calls).toBe(2);
    stop();
    inbox.set(TOKEN);
    expect(calls).toBe(2);
  });
});
