import type { AuthState } from '../types/auth';

export const LOGIN_PATH = '/login' as const;
/** Where a meeting link takes a signed-in person. */
export const MEETINGS_PATH = '/meetings' as const;
/** Where a person lands after signing in. */
export const HOME_PATH = '/' as const;

/**
 * Where the window must go for the signed-in state, or null to stay put. While the saved
 * session is still being checked nothing moves, so a reload does not bounce through /login.
 * A meeting link waiting to be handled takes a signed-in person to the Meetings page, from
 * the login screen or anywhere else, since that is where it is offered.
 */
export function guardRedirect(
  auth: AuthState,
  pathname: string,
  hasPendingInvite = false,
): typeof LOGIN_PATH | typeof HOME_PATH | typeof MEETINGS_PATH | null {
  if (auth.status === 'unknown') return null;
  const onLogin = pathname === LOGIN_PATH;
  if (auth.status === 'signedOut' && !onLogin) return LOGIN_PATH;
  if (auth.status === 'signedIn' && hasPendingInvite && pathname !== MEETINGS_PATH) return MEETINGS_PATH;
  if (auth.status === 'signedIn' && onLogin) return HOME_PATH;
  return null;
}
