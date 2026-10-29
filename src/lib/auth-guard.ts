import type { AuthState } from '../types/auth';

export const LOGIN_PATH = '/login' as const;
/** Where a person lands after signing in. */
export const HOME_PATH = '/' as const;

/**
 * Where the window must go for the signed-in state, or null to stay put. While the saved
 * session is still being checked nothing moves, so a reload does not bounce through /login.
 */
export function guardRedirect(auth: AuthState, pathname: string): typeof LOGIN_PATH | typeof HOME_PATH | null {
  if (auth.status === 'unknown') return null;
  const onLogin = pathname === LOGIN_PATH;
  if (auth.status === 'signedOut' && !onLogin) return LOGIN_PATH;
  if (auth.status === 'signedIn' && onLogin) return HOME_PATH;
  return null;
}
