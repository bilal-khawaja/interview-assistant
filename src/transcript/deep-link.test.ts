import { describe, expect, test } from 'bun:test';
import { findJoinUrl, parseJoinUrl } from './deep-link';
import { DeepLinkInbox } from './services/deep-link-inbox';

const TOKEN = 'k3J9_aZx-0pQwErTyUiOpAsDfGhJkLzXcVbNm12345A';
const LINK = `interview-assistant://join/${TOKEN}`;

describe('parseJoinUrl', () => {
  test('reads the token from the app link, whatever the case of the scheme', () => {
    expect(parseJoinUrl(LINK)).toBe(TOKEN);
    expect(parseJoinUrl(`  ${LINK}/ `)).toBe(TOKEN);
    expect(parseJoinUrl(LINK.replace('interview-assistant', 'Interview-Assistant'))).toBe(TOKEN);
  });

  test('refuses other schemes, other paths and bare tokens', () => {
    for (const url of [
      TOKEN,
      `https://example.test/join/${TOKEN}`,
      `interview-assistant://other/${TOKEN}`,
      'interview-assistant://join/short',
      `interview-assistant://join/${TOKEN}/extra`,
      '--flag',
      '',
    ]) {
      expect(parseJoinUrl(url), url).toBeNull();
    }
  });
});

describe('findJoinUrl', () => {
  test('finds the link among a process\'s arguments', () => {
    expect(findJoinUrl(['electron.exe', '.', '--inspect', LINK])).toBe(LINK);
    expect(findJoinUrl(['electron.exe', '.'])).toBeNull();
  });
});

describe('DeepLinkInbox', () => {
  test('keeps the invite until it is taken, and only once', () => {
    const inbox = new DeepLinkInbox();
    expect(inbox.receive(LINK)).toBe(true);
    expect(inbox.take()).toBe(TOKEN);
    expect(inbox.take()).toBeNull();
  });

  test('ignores URLs that are not join links', () => {
    const inbox = new DeepLinkInbox();
    expect(inbox.receive('https://example.test')).toBe(false);
    expect(inbox.take()).toBeNull();
  });

  test('tells a listener straight away and a newer link replaces an older one', () => {
    const inbox = new DeepLinkInbox();
    const seen: string[] = [];
    const stop = inbox.onToken((token) => seen.push(token));
    inbox.receive(LINK);
    inbox.receive(`interview-assistant://join/${TOKEN.replace('k3', 'zz')}`);
    stop();
    inbox.receive(LINK);
    expect(seen).toEqual([TOKEN, TOKEN.replace('k3', 'zz')]);
    expect(inbox.take()).toBe(TOKEN);
  });
});
