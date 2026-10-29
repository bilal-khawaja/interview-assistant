import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { BackendApi, BackendApiError } from '../transcript/services/backend-api.client';
import { MeetingChatService } from '../transcript/services/meeting-chat.service';
import { MeetingService, type TranscriptEvent } from '../transcript/services/meeting.service';
import { FakeBackend, until } from '../transcript/testing/fake-backend';
import type { AuthState } from '../types/auth';
import { AuthService } from './auth.service';
import { APP_ORIGIN } from './constants';
import type { TokenStore } from './token-store';

class MemoryStore implements TokenStore {
  token: string | null = null;
  saves = 0;
  load = () => this.token;
  save(token: string) {
    this.token = token;
    this.saves++;
    return true;
  }
  clear() {
    this.token = null;
  }
}

let backend: FakeBackend;
let api: BackendApi;
let store: MemoryStore;
let auth: AuthService;
let states: AuthState[];

const PASSWORD = 'correct horse battery';

function make(options: ConstructorParameters<typeof AuthService>[2] = {}) {
  api = new BackendApi(backend.url);
  store = new MemoryStore();
  states = [];
  auth = new AuthService(api, store, options);
  auth.onChange((state) => states.push(state));
}

beforeEach(() => {
  backend = new FakeBackend().start();
  backend.requireAuth = true;
  make();
});
afterEach(async () => {
  await backend.stop();
});

describe('AuthService', () => {
  test('sign-up signs in, keeps the token and presents the app origin', async () => {
    const state = await auth.signUp({ name: ' Ada ', email: ' Ada@Example.com ', password: PASSWORD });
    expect(state).toMatchObject({ status: 'signedIn', user: { email: 'ada@example.com', name: 'Ada' } });
    expect(store.token).toBeTruthy();
    expect(backend.authOrigins).toEqual([APP_ORIGIN]);
    expect((await api.listMeetings()).length).toBe(0);
    expect(backend.seenAuthorization.at(-1)).toBe(`Bearer ${store.token}`);
  });

  test('the state shown to the window never carries the token', async () => {
    await auth.signUp({ name: 'Ada', email: 'a@example.com', password: PASSWORD });
    expect(JSON.stringify(states)).not.toContain(store.token!);
    expect(JSON.stringify(auth.current)).not.toContain(store.token!);
  });

  test('sign-in with a wrong password fails, keeps the app signed out and does not look like an expired session', async () => {
    backend.addAccount('a@example.com', PASSWORD);
    const error = await auth.signIn({ email: 'a@example.com', password: 'nope nope nope' }).catch((e) => e);
    expect(error).toBeInstanceOf(BackendApiError);
    expect(error).toMatchObject({ status: 401, message: 'Invalid email or password' });
    expect(auth.current.status).toBe('unknown');
    expect(states).toEqual([]);
    expect(store.token).toBeNull();
    expect(api.hasToken).toBe(false);
  });

  test('sign-up with a taken email reports the backend message', async () => {
    backend.addAccount('a@example.com', PASSWORD);
    const error = await auth.signUp({ name: 'x', email: 'A@example.com', password: PASSWORD }).catch((e) => e);
    expect(error).toMatchObject({ status: 422, message: 'User already exists' });
  });

  describe('restore', () => {
    test('with no saved token the app is signed out', async () => {
      expect(await auth.restore()).toEqual({ status: 'signedOut' });
    });

    test('a saved token that still works signs in', async () => {
      backend.addAccount('a@example.com', PASSWORD, 'Ada');
      store.token = backend.issueToken('a@example.com');
      expect(await auth.restore()).toMatchObject({ status: 'signedIn', user: { email: 'a@example.com' } });
    });

    test('a saved token the backend no longer knows is dropped', async () => {
      backend.addAccount('a@example.com', PASSWORD);
      store.token = backend.issueToken('a@example.com');
      backend.revoke(store.token);
      expect(await auth.restore()).toEqual({ status: 'signedOut', reason: 'expired' });
      expect(store.token).toBeNull();
      expect(api.hasToken).toBe(false);
    });

    test('an unreachable backend keeps the token so a retry can sign in', async () => {
      backend.addAccount('a@example.com', PASSWORD);
      const token = backend.issueToken('a@example.com');
      store.token = token;
      const port = await backend.kill();
      expect(await auth.restore()).toEqual({ status: 'signedOut', reason: 'unreachable' });
      expect(store.token).toBe(token);
      backend = new FakeBackend().start(port);
      backend.requireAuth = true;
      backend.addAccount('a@example.com', PASSWORD);
      backend.tokens.set(token, 'a@example.com');
      expect(await auth.restore()).toMatchObject({ status: 'signedIn' });
    });
  });

  describe('a lost session', () => {
    test('a 401 on any request signs the app out once, however many requests fail together', async () => {
      await auth.signUp({ name: 'Ada', email: 'a@example.com', password: PASSWORD });
      backend.revoke(store.token!);
      const results = await Promise.allSettled([api.listMeetings(), api.getMeeting('x'), api.listMeetings()]);
      expect(results.every((r) => r.status === 'rejected')).toBe(true);
      expect(states.filter((s) => s.status === 'signedOut')).toEqual([{ status: 'signedOut', reason: 'expired' }]);
      expect(store.token).toBeNull();
      expect(api.hasToken).toBe(false);
    });

    test('requests made without a token never count as a lost session', async () => {
      await api.listMeetings().catch(() => undefined);
      expect(states).toEqual([]);
    });
  });

  describe('sign-out', () => {
    test('runs the hook while the token still works, then revokes the session', async () => {
      let sawToken: string | null = null;
      make({
        beforeSignOut: async () => {
          sawToken = backend.seenAuthorization.at(-1) ?? null;
          await api.listMeetings();
          sawToken = backend.seenAuthorization.at(-1) ?? null;
        },
      });
      await auth.signUp({ name: 'Ada', email: 'a@example.com', password: PASSWORD });
      const token = store.token!;
      expect(await auth.signOut()).toEqual({ status: 'signedOut', reason: 'signed-out' });
      expect(sawToken).toBe(`Bearer ${token}`);
      expect(backend.tokens.has(token)).toBe(false);
      expect(store.token).toBeNull();
      expect(backend.authOrigins.at(-1)).toBe(APP_ORIGIN);
    });

    test('a hook that fails or hangs does not stop the sign-out', async () => {
      make({ beforeSignOut: () => new Promise<void>(() => undefined), beforeSignOutTimeoutMs: 30 });
      await auth.signUp({ name: 'Ada', email: 'a@example.com', password: PASSWORD });
      expect(await auth.signOut()).toMatchObject({ status: 'signedOut' });
      make({ beforeSignOut: () => Promise.reject(new Error('boom')) });
      await auth.signUp({ name: 'Bo', email: 'b@example.com', password: PASSWORD });
      expect(await auth.signOut()).toMatchObject({ status: 'signedOut' });
    });

    test('signs out locally even when the backend cannot be reached', async () => {
      await auth.signUp({ name: 'Ada', email: 'a@example.com', password: PASSWORD });
      await backend.kill();
      expect(await auth.signOut()).toEqual({ status: 'signedOut', reason: 'signed-out' });
      expect(store.token).toBeNull();
    });
  });
});

describe('the token on streams', () => {
  const texts = (events: TranscriptEvent[]) => events.flatMap((e) => (e.type === 'segment' ? [e.event.segment.text] : []));

  test('transcript and audio sockets are accepted only because they carry the token', async () => {
    backend.addAccount('a@example.com', PASSWORD);
    store.token = backend.issueToken('a@example.com');
    await auth.restore();
    const service = new MeetingService(api, { pollMs: 30, streamOptions: { reconnect: { baseMs: 10, maxMs: 40 } }, uplinkOptions: { reconnect: { baseMs: 10, maxMs: 40 } } });
    const events: TranscriptEvent[] = [];
    service.onEvent((e) => events.push(e));
    try {
      const meeting = await service.start({ source: 'live', title: 'mic' });
      await until(() => backend.streams.size === 1 && backend.audios.size === 1);
      backend.push(meeting.id, 'hello');
      await until(() => texts(events).includes('hello'));
      service.sendAudio(new Uint8Array(3200).fill(1));
      await until(() => backend.audioFrames.length === 1);
    } finally {
      service.dispose();
    }
  });

  test('without a token the backend refuses the socket and the stream never goes live', async () => {
    const meeting = backend.addMeeting();
    const service = new MeetingService(new BackendApi(backend.url), { pollMs: 1_000, streamOptions: { reconnect: { baseMs: 10, maxMs: 20 } } });
    const events: TranscriptEvent[] = [];
    service.onEvent((e) => events.push(e));
    try {
      await expect(service.subscribe(meeting.id)).rejects.toMatchObject({ status: 401 });
      expect(backend.streams.size).toBe(0);
    } finally {
      service.dispose();
    }
  });

  test('chat streams carry the token too, and unfollowAll closes them', async () => {
    backend.addAccount('a@example.com', PASSWORD);
    store.token = backend.issueToken('a@example.com');
    await auth.restore();
    const meeting = backend.addMeeting();
    const chat = backend.addChat(meeting.id, 'c');
    const chats = new MeetingChatService(api, { streamOptions: { reconnect: { baseMs: 10, maxMs: 40 } } });
    try {
      chats.follow(meeting.id, chat.id);
      await until(() => backend.chatSockets.size === 1);
      chats.unfollowAll();
      await until(() => backend.chatSockets.size === 0);
    } finally {
      chats.dispose();
    }
  });
});
