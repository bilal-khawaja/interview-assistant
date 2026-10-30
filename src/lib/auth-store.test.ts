import { beforeEach, describe, expect, test } from 'bun:test';
import type { AuthState, SignInInput, SignUpInput } from '../types/auth';
import type { ApiResult } from '../types/transcript';
import { AuthStore, userOf, type AuthApi } from './auth-store';
import { guardRedirect } from './auth-guard';
import { startSession, type SessionTargets } from './session';

const ada: AuthState = { status: 'signedIn', user: { id: 'u-ada', email: 'ada@example.com', name: 'Ada' } };
const bo: AuthState = { status: 'signedIn', user: { id: 'u-bo', email: 'bo@example.com', name: 'Bo' } };
const out: AuthState = { status: 'signedOut' };

class FakeApi implements AuthApi {
  handler: ((state: AuthState) => void) | null = null;
  listens = 0;
  current: AuthState = { status: 'unknown' };
  restored: AuthState = out;
  signInResult: ApiResult<{ state: AuthState }> = { state: ada };
  signUpResult: ApiResult<{ state: AuthState }> = { state: ada };
  signedInWith: SignInInput[] = [];
  signedUpWith: SignUpInput[] = [];
  signOutResult: AuthState = { status: 'signedOut', reason: 'signed-out' };
  gate: Promise<void> | null = null;

  async state() {
    await this.gate;
    return this.current;
  }
  async restore() {
    return this.restored;
  }
  async signIn(input: SignInInput) {
    this.signedInWith.push(input);
    await this.gate;
    return this.signInResult;
  }
  async signUp(input: SignUpInput) {
    this.signedUpWith.push(input);
    return this.signUpResult;
  }
  async signOut() {
    return this.signOutResult;
  }
  listen(handler: (state: AuthState) => void) {
    this.listens++;
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }
  /** The main process pushing a new state. */
  push(state: AuthState) {
    this.handler?.(state);
  }
}

let api: FakeApi;
let store: AuthStore;

beforeEach(() => {
  api = new FakeApi();
  store = new AuthStore(api);
});

describe('AuthStore', () => {
  test('starts unknown and takes whatever the main process says on init', async () => {
    expect(store.getState().auth).toEqual({ status: 'unknown' });
    api.current = ada;
    await store.init();
    expect(store.getState().auth).toEqual(ada);
    expect(store.getState().busy).toBe(false);
  });

  test('init listens once, however often it is called', async () => {
    await store.init();
    await store.init();
    expect(api.listens).toBe(1);
  });

  test('sign-in success moves to signed in and reports it', async () => {
    api.current = out;
    await store.init();
    expect(await store.signIn({ email: 'ada@example.com', password: 'pw' })).toBe(true);
    expect(store.getState().auth).toEqual(ada);
    expect(api.signedInWith).toEqual([{ email: 'ada@example.com', password: 'pw' }]);
  });

  test('a failed sign-in keeps the window signed out and shows the reason', async () => {
    api.current = out;
    await store.init();
    api.signInResult = { error: 'Invalid email or password', status: 401 };
    expect(await store.signIn({ email: 'ada@example.com', password: 'nope' })).toBe(false);
    expect(store.getState().auth).toEqual(out);
    expect(store.getState().error).toBe('Invalid email or password');
    expect(store.getState().busy).toBe(false);
  });

  test('a new attempt clears the old error, and clearError does too', async () => {
    api.current = out;
    await store.init();
    api.signInResult = { error: 'Invalid email or password' };
    await store.signIn({ email: 'a', password: 'b' });
    api.signInResult = { state: ada };
    await store.signIn({ email: 'a', password: 'b' });
    expect(store.getState().error).toBeNull();
    api.signUpResult = { error: 'User already exists' };
    await store.signUp({ name: 'x', email: 'a', password: 'b' });
    expect(store.getState().error).toBe('User already exists');
    store.clearError();
    expect(store.getState().error).toBeNull();
  });

  test('sign-up signs the new account in', async () => {
    api.current = out;
    await store.init();
    api.signUpResult = { state: bo };
    expect(await store.signUp({ name: 'Bo', email: 'bo@example.com', password: 'longenough' })).toBe(true);
    expect(userOf(store.getState().auth)?.name).toBe('Bo');
  });

  test('a second attempt while one is in flight is ignored', async () => {
    api.current = out;
    await store.init();
    let release!: () => void;
    api.gate = new Promise<void>((resolve) => (release = resolve));
    const first = store.signIn({ email: 'a', password: 'b' });
    expect(await store.signIn({ email: 'a', password: 'b' })).toBe(false);
    release();
    await first;
    expect(api.signedInWith).toHaveLength(1);
  });

  test('sign-out lands signed out with the reason the main process gave', async () => {
    api.current = ada;
    await store.init();
    await store.signOut();
    expect(store.getState().auth).toEqual({ status: 'signedOut', reason: 'signed-out' });
  });

  describe('a session lost while the window is open (401)', () => {
    test('the main process pushes signed out, and the window follows', async () => {
      api.current = ada;
      await store.init();
      api.push({ status: 'signedOut', reason: 'expired' });
      expect(store.getState().auth).toEqual({ status: 'signedOut', reason: 'expired' });
    });

    test('the same state pushed twice is reported once', async () => {
      api.current = ada;
      await store.init();
      const seen: AuthState[] = [];
      store.onTransition((_previous, next) => seen.push(next));
      api.push({ status: 'signedOut', reason: 'expired' });
      api.push({ status: 'signedOut', reason: 'expired' });
      expect(seen).toEqual([{ status: 'signedOut', reason: 'expired' }]);
    });

    test('refresh asks the main process to check the session again', async () => {
      api.current = { status: 'signedOut', reason: 'unreachable' };
      await store.init();
      api.restored = ada;
      await store.refresh();
      expect(store.getState().auth).toEqual(ada);
    });
  });

  test('subscribers are told about changes and can stop listening', async () => {
    let calls = 0;
    const off = store.subscribe(() => calls++);
    await store.init();
    expect(calls).toBeGreaterThan(0);
    const seen = calls;
    off();
    api.push(ada);
    expect(calls).toBe(seen);
  });

  test('the token is not part of any state the window holds', async () => {
    api.current = ada;
    await store.init();
    expect(Object.keys(store.getState().auth)).toEqual(['status', 'user']);
    expect(Object.keys((store.getState().auth as { user: object }).user).sort()).toEqual(['email', 'id', 'name']);
  });
});

describe('guardRedirect', () => {
  test('while the session is being checked nothing moves', () => {
    expect(guardRedirect({ status: 'unknown' }, '/ai')).toBeNull();
    expect(guardRedirect({ status: 'unknown' }, '/login')).toBeNull();
  });

  test('signed out goes to /login from anywhere else, and stays there', () => {
    for (const path of ['/', '/ai', '/meetings', '/settings/account', '/realtime']) {
      expect(guardRedirect(out, path)).toBe('/login');
    }
    expect(guardRedirect(out, '/login')).toBeNull();
  });

  test('signed in leaves /login and is otherwise free to go anywhere', () => {
    expect(guardRedirect(ada, '/login')).toBe('/');
    for (const path of ['/', '/ai', '/meetings', '/settings/account']) expect(guardRedirect(ada, path)).toBeNull();
  });

  test('a waiting meeting link takes a signed-in person to /meetings, even straight from /login', () => {
    expect(guardRedirect(ada, '/login', true)).toBe('/meetings');
    expect(guardRedirect(ada, '/ai', true)).toBe('/meetings');
    expect(guardRedirect(ada, '/meetings', true)).toBeNull();
  });

  test('a waiting meeting link does not unlock anything for someone signed out or not yet checked', () => {
    expect(guardRedirect(out, '/meetings', true)).toBe('/login');
    expect(guardRedirect(out, '/login', true)).toBeNull();
    expect(guardRedirect({ status: 'unknown' }, '/ai', true)).toBeNull();
  });
});

describe('startSession', () => {
  let calls: string[];
  let targets: SessionTargets;

  beforeEach(() => {
    calls = [];
    targets = {
      configureBackend: async () => void calls.push('configure'),
      startMeetings: async () => void calls.push('start'),
      resetMeetings: () => void calls.push('reset-meetings'),
      resetMeetingChats: () => void calls.push('reset-chats'),
      switchChatTabs: (id) => void calls.push(`tabs:${id}`),
    };
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  test('the backend address is applied before the saved session is checked', async () => {
    let initAt = -1;
    api.current = ada;
    const original = api.state.bind(api);
    api.state = async () => {
      initAt = calls.length;
      return original();
    };
    startSession(store, targets);
    await settle();
    expect(calls.slice(0, initAt)).toEqual(['configure']);
  });

  test('signing in loads that account\'s tabs and meetings', async () => {
    api.current = ada;
    startSession(store, targets);
    await settle();
    expect(calls).toEqual(['configure', 'tabs:u-ada', 'start']);
  });

  test('a restored signed-out window loads nothing', async () => {
    api.current = out;
    startSession(store, targets);
    await settle();
    expect(calls).toEqual(['configure']);
  });

  test('signing out drops the account\'s data before anything else, then clears the tabs', async () => {
    api.current = ada;
    startSession(store, targets);
    await settle();
    calls.length = 0;
    api.push({ status: 'signedOut', reason: 'expired' });
    expect(calls).toEqual(['reset-meetings', 'reset-chats', 'tabs:null']);
  });

  test('another account signing in resets the first one\'s data before loading its own', async () => {
    api.current = ada;
    startSession(store, targets);
    await settle();
    calls.length = 0;
    api.push(bo);
    expect(calls).toEqual(['reset-meetings', 'reset-chats', 'tabs:u-bo', 'start']);
  });

  test('a state change that keeps the same account does nothing', async () => {
    api.current = ada;
    startSession(store, targets);
    await settle();
    calls.length = 0;
    api.push({ status: 'signedIn', user: { ...(ada as { user: object }).user, name: 'Ada L.' } as never });
    expect(calls).toEqual([]);
  });
});
