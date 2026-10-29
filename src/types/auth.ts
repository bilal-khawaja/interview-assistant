export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

/** Why the app is signed out, so the login screen can say something useful. */
export type SignedOutReason = 'signed-out' | 'expired' | 'unreachable';

export type AuthState =
  /** The saved session has not been checked yet. */
  | { status: 'unknown' }
  | { status: 'signedIn'; user: AuthUser }
  | { status: 'signedOut'; reason?: SignedOutReason };

export interface SignInInput {
  email: string;
  password: string;
}

export interface SignUpInput extends SignInInput {
  name: string;
}
