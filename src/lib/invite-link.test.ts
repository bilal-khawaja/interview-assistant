import { describe, expect, test } from 'bun:test';
import { INVITE_LINK_PREFIX, parseInviteToken } from './invite-link';

const TOKEN = 'k3J9_aZx-0pQwErTyUiOpAsDfGhJkLzXcVbNm12345A';

describe('parseInviteToken', () => {
  test('reads the token from the app link', () => {
    expect(parseInviteToken(`${INVITE_LINK_PREFIX}${TOKEN}`)).toBe(TOKEN);
  });

  test('reads it from a web address, with or without a trailing slash or query', () => {
    expect(parseInviteToken(`https://example.test/join/${TOKEN}`)).toBe(TOKEN);
    expect(parseInviteToken(`https://example.test/join/${TOKEN}/`)).toBe(TOKEN);
    expect(parseInviteToken(`https://example.test/join/${TOKEN}?from=chat`)).toBe(TOKEN);
  });

  test('accepts the bare token and ignores surrounding whitespace', () => {
    expect(parseInviteToken(TOKEN)).toBe(TOKEN);
    expect(parseInviteToken(`  ${INVITE_LINK_PREFIX}${TOKEN}\n`)).toBe(TOKEN);
  });

  test('refuses anything that cannot be a token', () => {
    for (const input of ['', '   ', 'hello world', 'short', `${INVITE_LINK_PREFIX}short`, `${INVITE_LINK_PREFIX}${TOKEN}/extra`, 'https://example.test/other/' + TOKEN]) {
      expect(parseInviteToken(input), input).toBeNull();
    }
  });
});
