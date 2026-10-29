import type { AuthState, AuthUser, SignInInput, SignUpInput, SignedOutReason } from '../types/auth';
import { BackendApiError, type BackendApi } from '../transcript/services/backend-api.client';
import type { TokenStore } from './token-store';

export interface AuthServiceOptions {
  /**
   * Runs while the user is still signed in when they sign out, e.g. to end a meeting this
   * app started, which needs the token. Failures and slowness never block signing out.
   */
  beforeSignOut?: () => Promise<void>;
  beforeSignOutTimeoutMs?: number;
}

const DEFAULT_BEFORE_SIGN_OUT_MS = 8_000;

/**
 * The app's account: signs up, signs in and out, keeps the session token (in memory and in
 * the encrypted store) and tells listeners when the signed-in state changes. A 401 on any
 * request that carried the token means the session is gone, and signs the app out.
 */
export class AuthService {
  private state: AuthState = { status: 'unknown' };
  private readonly listeners = new Set<(state: AuthState) => void>();

  constructor(
    private readonly api: BackendApi,
    private readonly store: TokenStore,
    private readonly options: AuthServiceOptions = {},
  ) {
    api.onUnauthorized(() => this.drop('expired'));
  }

  get current(): AuthState {
    return this.state;
  }

  onChange(listener: (state: AuthState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Picks up the session saved by an earlier run. If the backend cannot be reached the saved
   * token is kept and the app reports signed out as 'unreachable', so retrying later works.
   */
  async restore(): Promise<AuthState> {
    if (!this.api.hasToken) {
      const saved = this.store.load();
      if (saved) this.api.setToken(saved);
    }
    if (!this.api.hasToken) return this.set({ status: 'signedOut' });
    try {
      return this.set({ status: 'signedIn', user: await this.api.me() });
    } catch (error) {
      if (error instanceof BackendApiError && error.status === 401) return this.drop('expired');
      return this.set({ status: 'signedOut', reason: 'unreachable' });
    }
  }

  async signIn(input: SignInInput): Promise<AuthState> {
    return this.begin(await this.api.signIn({ ...input, email: input.email.trim() }));
  }

  async signUp(input: SignUpInput): Promise<AuthState> {
    return this.begin(await this.api.signUp({ ...input, email: input.email.trim(), name: input.name.trim() }));
  }

  async signOut(): Promise<AuthState> {
    if (this.api.hasToken) {
      const timeout = this.options.beforeSignOutTimeoutMs ?? DEFAULT_BEFORE_SIGN_OUT_MS;
      await Promise.race([
        (this.options.beforeSignOut?.() ?? Promise.resolve()).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, timeout)),
      ]);
      // Revoke the session on the server; if that fails the local sign-out still happens.
      await this.api.signOut().catch(() => undefined);
    }
    return this.drop('signed-out');
  }

  private begin({ token, user }: { token: string; user: AuthUser }): AuthState {
    this.api.setToken(token);
    this.store.save(token);
    return this.set({ status: 'signedIn', user });
  }

  /** Forgets the session. Repeated calls (several requests failing at once) report once. */
  private drop(reason: SignedOutReason): AuthState {
    const had = this.api.hasToken;
    this.api.setToken(null);
    this.store.clear();
    if (!had && this.state.status === 'signedOut') return this.state;
    return this.set({ status: 'signedOut', reason });
  }

  private set(state: AuthState): AuthState {
    this.state = state;
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // a dead window must not break delivery to the others
      }
    }
    return state;
  }
}
