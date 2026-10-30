/** The scheme the desktop app registers, and the path its join links carry the token on. */
export const INVITE_LINK_PREFIX = 'interview-assistant://join/';

const TOKEN = /^[A-Za-z0-9_-]{16,256}$/;

/**
 * The invite token in whatever a person pasted: the whole join link, a web address that ends in
 * the token, or the bare token. Null when it holds nothing that could be one.
 */
export function parseInviteToken(input: string): string | null {
  const text = input.trim();
  if (TOKEN.test(text)) return text;
  const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^?#]*\/)?join\/([^/?#\s]+)\/?(?:[?#].*)?$/i.exec(text);
  const token = match?.[1];
  return token && TOKEN.test(token) ? token : null;
}
