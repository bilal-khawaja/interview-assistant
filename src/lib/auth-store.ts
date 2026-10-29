import type { ApiResult } from '../types/transcript';
import type { AuthState, AuthUser, SignInInput, SignUpInput } from '../types/auth';

/** What the store needs from the main process. The app wires this to tipc. */
export interface AuthApi {
  /** The current state; the main process checks the saved session first if it has not yet. */
  state(): Promise<AuthState>;
  /** Checks the saved session again, e.g. after the backend was unreachable. */
  restore(): Promise<AuthState>;
  signIn(input: SignInInput): Promise<ApiResult<{ state: AuthState }>>;
  signUp(input: SignUpInput): Promise<ApiResult<{ state: AuthState }>>;
  signOut(): Promise<AuthState>;
  /** The main process pushes the new state whenever it changes (including a lost session). */
  listen(handler: (state: AuthState) => void): () => void;
}

export interface AuthViewState {
  auth: AuthState;
  /** A sign-in, sign-up, sign-out or session check is in flight. */
  busy: boolean;
  /** The last sign-in or sign-up failure, in words for the person. */
  error: string | null;
}

export const userOf = (state: AuthState): AuthUser | null => (state.status === 'signedIn' ? state.user : null);

/**
 * The account as the window sees it. The session token never gets here: the main process
 * keeps it and reports only who is signed in.
 */
export class AuthStore {
  private state: AuthViewState = { auth: { status: 'unknown' }, busy: false, error: null };
  private readonly subscribers = new Set<() => void>();
  private readonly transitions = new Set<(previous: AuthState, next: AuthState) => void>();
  private unlisten: (() => void) | null = null;

  constructor(private readonly api: AuthApi) {}

  // --- external store contract (useSyncExternalStore) ---

  subscribe = (listener: () => void): (() => void) => {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  };

  getState = (): AuthViewState => this.state;

  /**
   * Called each time the signed-in state changes, with the one before it. The app uses it to
   * drop one account's data and load the next one's.
   */
  onTransition(listener: (previous: AuthState, next: AuthState) => void): () => void {
    this.transitions.add(listener);
    return () => this.transitions.delete(listener);
  }

  private set(patch: Partial<AuthViewState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.subscribers) listener();
  }

  private apply(next: AuthState): void {
    const previous = this.state.auth;
    this.set({ auth: next });
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    for (const listener of this.transitions) listener(previous, next);
  }

  // --- lifecycle ---

  /** Starts listening to the main process and reads the current state. Safe to repeat. */
  async init(): Promise<void> {
    if (this.unlisten) return;
    this.unlisten = this.api.listen((next) => this.apply(next));
    this.set({ busy: true });
    try {
      this.apply(await this.api.state());
    } finally {
      this.set({ busy: false });
    }
  }

  dispose(): void {
    this.unlisten?.();
    this.unlisten = null;
  }

  // --- actions ---

  /** Checks the saved session again. For the "backend unreachable" case. */
  async refresh(): Promise<void> {
    if (this.state.busy) return;
    this.set({ busy: true, error: null });
    try {
      this.apply(await this.api.restore());
    } finally {
      this.set({ busy: false });
    }
  }

  /** Returns true when the person is now signed in. */
  signIn(input: SignInInput): Promise<boolean> {
    return this.authenticate(() => this.api.signIn(input));
  }

  signUp(input: SignUpInput): Promise<boolean> {
    return this.authenticate(() => this.api.signUp(input));
  }

  async signOut(): Promise<void> {
    if (this.state.busy) return;
    this.set({ busy: true, error: null });
    try {
      this.apply(await this.api.signOut());
    } finally {
      this.set({ busy: false });
    }
  }

  clearError(): void {
    this.set({ error: null });
  }

  private async authenticate(call: () => Promise<ApiResult<{ state: AuthState }>>): Promise<boolean> {
    if (this.state.busy) return false;
    this.set({ busy: true, error: null });
    try {
      const result = await call();
      if (result.error !== undefined) {
        this.set({ error: result.error });
        return false;
      }
      this.apply(result.state);
      return result.state.status === 'signedIn';
    } finally {
      this.set({ busy: false });
    }
  }
}
