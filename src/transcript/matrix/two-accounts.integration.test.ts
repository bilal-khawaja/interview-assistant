import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import type { StreamStatus, TranscriptSegment } from '../../types/transcript';
import { BackendApi, BackendApiError } from '../services/backend-api.client';
import { MeetingService, type TranscriptEvent } from '../services/meeting.service';
import { BackendProcess } from './backend-process';
import { FakeDeepgram } from './fake-deepgram';

/**
 * Two accounts in one meeting, end to end: the real backend (a bun subprocess against the test
 * database), the real MeetingService for each account, and only Deepgram faked. One account
 * hosts, the other joins through an invite link and speaks. Opt-in like the failure matrix:
 *
 *   MATRIX=1 bun test src/transcript/matrix/two-accounts
 */
const enabled = process.env.MATRIX === '1';
const run = enabled ? describe : describe.skip;

const BACKEND_DIR = path.resolve(import.meta.dir, '../../../backend/server');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const deepgram = new FakeDeepgram();
let backend: BackendProcess;

async function until(check: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}\n--- backend output ---\n${backend?.logs ?? ''}`);
}

/** One account's app window: its own session, service and microphone. */
class Window {
  readonly events: TranscriptEvent[] = [];
  readonly service: MeetingService;
  readonly api: BackendApi;
  private mic: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly userId: string,
    token: string,
  ) {
    this.api = new BackendApi(backend.url);
    this.api.setToken(token);
    this.service = new MeetingService(this.api, {
      pollMs: 300,
      drainMs: 800,
      drainMaxMs: 8_000,
      streamOptions: { reconnect: { baseMs: 100, maxMs: 500 } },
      uplinkOptions: { reconnect: { baseMs: 100, maxMs: 500 } },
    });
    this.service.onEvent((event) => this.events.push(event));
  }

  get segments(): TranscriptSegment[] {
    return this.events.flatMap((e) => (e.type === 'segment' ? [e.event.segment] : []));
  }

  get statuses(): StreamStatus[] {
    return this.events.flatMap((e) => (e.type === 'status' ? [e.event.status] : []));
  }

  /** What the transcript holds from one account's microphone. */
  from(userId: string): TranscriptSegment[] {
    return this.segments.filter((s) => s.speakerKey === `user:${userId}`);
  }

  startMic(): void {
    this.stopMic();
    this.mic = setInterval(() => this.service.sendAudio(new Uint8Array(3200).fill(1)), 100);
  }

  stopMic(): void {
    if (this.mic) clearInterval(this.mic);
    this.mic = null;
  }

  close(): void {
    this.stopMic();
    this.service.dispose();
  }
}

let alice: Window;
let bob: Window;
const windows: Window[] = [];

async function account(name: string): Promise<Window> {
  const signedUp = await new BackendApi(backend.url).signUp({
    name,
    email: `${name.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`,
    password: 'two-accounts-password-1',
  });
  const window = new Window(signedUp.user.id, signedUp.token);
  windows.push(window);
  return window;
}

beforeAll(async () => {
  if (!enabled) return;
  await deepgram.start();
  backend = new BackendProcess(BACKEND_DIR, { DEEPGRAM_API_KEY: 'matrix', DEEPGRAM_WS_URL: deepgram.url });
  await backend.start();
}, 60_000);

afterEach(async () => {
  if (!enabled) return;
  for (const window of windows.splice(0)) window.close();
}, 30_000);

afterAll(async () => {
  if (!enabled) return;
  await backend?.stop();
  await deepgram.stop();
});

run('two accounts in one meeting', () => {
  test('a guest joins through a link, speaks, is heard by the host, leaves, is removed and cannot come back on the old link', async () => {
    alice = await account('Alice');
    bob = await account('Bob');

    // Alice hosts and speaks.
    const meeting = await alice.service.start({ source: 'live', title: 'two accounts' });
    alice.startMic();
    await until(() => alice.from(alice.userId).length >= 2, 30_000, 'the host to be transcribed');

    // Bob cannot see it until he joins.
    await expect(bob.api.getMeeting(meeting.id)).rejects.toMatchObject({ status: 404 });
    const invite = await alice.service.createInvite(meeting.id, { expiresInMinutes: 60, maxUses: 2 });
    expect(invite.url).toBe(`interview-assistant://join/${invite.token}`);

    // Bob joins and speaks: both hear both, and each line is named after its speaker.
    const joined = await bob.service.join(invite.token, true);
    expect(joined).toMatchObject({ id: meeting.id, role: 'participant' });
    bob.startMic();
    await until(() => bob.from(bob.userId).length >= 2, 30_000, 'the guest to be transcribed');
    await until(() => alice.from(bob.userId).length >= 2, 30_000, 'the host to see the guest');
    await until(
      () => alice.segments.some((s) => s.speaker?.person.fullName === 'Bob') && bob.segments.some((s) => s.speaker?.person.fullName === 'Alice'),
      15_000,
      'speakers to be named',
    );
    const named = (w: Window, name: string) => w.segments.find((s) => s.speaker?.person.fullName === name)!;
    expect(named(alice, 'Bob').speaker?.role).toBe('participant');
    expect(named(bob, 'Alice').speaker?.role).toBe('host');

    // Everyone holds the same log from where they started following.
    const members = await alice.service.listMembers(meeting.id);
    expect(members.map((m) => [m.userId, m.role])).toEqual([
      [alice.userId, 'owner'],
      [bob.userId, 'participant'],
    ]);
    // The guest sees the same people, but not their addresses.
    const seenByBob = await bob.service.listMembers(meeting.id);
    expect(seenByBob.map((m) => m.userId)).toEqual([alice.userId, bob.userId]);
    expect(seenByBob.some((m) => m.email !== undefined)).toBe(false);
    expect((await alice.service.listInvites(meeting.id))[0]).toMatchObject({ useCount: 1, maxUses: 2 });

    // The guest cannot run the meeting.
    await expect(bob.service.end(meeting.id)).rejects.toMatchObject({ status: 404 });
    await expect(bob.service.createInvite(meeting.id, { expiresInMinutes: 60 })).rejects.toMatchObject({ status: 404 });

    // Bob leaves: the meeting goes on for Alice.
    bob.stopMic();
    await bob.service.leave(meeting.id);
    const before = alice.from(alice.userId).length;
    await until(() => alice.from(alice.userId).length > before, 20_000, 'the host to carry on after the guest left');
    expect((await alice.service.listMembers(meeting.id)).map((m) => m.userId)).toEqual([alice.userId]);
    await expect(bob.api.getMeeting(meeting.id)).rejects.toMatchObject({ status: 404 });

    // The same link brings him back (leaving is not a ban); then Alice removes him.
    await bob.service.join(invite.token, true);
    bob.startMic();
    await until(() => bob.segments.length > 0, 20_000, 'the returning guest to follow');
    await alice.service.removeMember(meeting.id, bob.userId);
    await until(() => bob.statuses.includes('removed'), 20_000, 'the guest to be told they were removed');
    expect(bob.service.activeMeeting).toBeNull();
    bob.stopMic();

    // The link he holds is older than his removal, so it no longer works for him.
    await expect(bob.service.join(invite.token, false)).rejects.toMatchObject({ status: 404 });
    // A new link does.
    const fresh = await alice.service.createInvite(meeting.id, { expiresInMinutes: 60 });
    await bob.service.join(fresh.token, false);
    expect(bob.service.activeMeeting?.role).toBe('participant');

    // Alice ends the meeting: it ends for Bob too, and it takes no more guests.
    alice.stopMic();
    await alice.service.end(meeting.id);
    await until(() => bob.statuses.includes('ended'), 30_000, 'the meeting to end for the guest');
    await expect(alice.service.createInvite(meeting.id, { expiresInMinutes: 60 })).rejects.toBeInstanceOf(BackendApiError);
    await expect(account('Carol').then((carol) => carol.service.join(fresh.token, false))).rejects.toMatchObject({ status: 404 });
  }, 180_000);
});
