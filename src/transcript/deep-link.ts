import { INVITE_LINK_PREFIX, parseInviteToken } from '../lib/invite-link';

/** The scheme the app registers with the operating system. */
export const APP_PROTOCOL = 'interview-assistant';

/** The invite token in a join link, or null for anything else (other schemes, other paths, junk). */
export function parseJoinUrl(url: string): string | null {
  const text = url.trim();
  return text.toLowerCase().startsWith(INVITE_LINK_PREFIX) ? parseInviteToken(text) : null;
}

/** The first join link among a process's arguments. Windows and Linux hand a clicked link over this way. */
export function findJoinUrl(argv: readonly string[]): string | null {
  return argv.find((arg) => parseJoinUrl(arg) !== null) ?? null;
}
