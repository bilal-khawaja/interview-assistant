import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import type { Meeting, StartMeetingInput, StreamStatus, TranscriptSegment } from '../../types/transcript';
import { BackendApi } from '../services/backend-api.client';
import { MeetingService, type TranscriptEvent } from '../services/meeting.service';
import { FakeDeepgram } from './fake-deepgram';
import { BackendProcess, dockerCommand, rssMb } from './backend-process';

/**
 * The failure matrix: the real backend (a bun subprocess against the test database) and the
 * real MeetingService, with only Deepgram faked. Each scenario breaks something mid-meeting
 * and checks the transcript is still complete, ordered and free of repeats.
 *
 *   MATRIX=1 bun test src/transcript/matrix                       live (microphone) source
 *   MATRIX=1 MATRIX_YOUTUBE=1 bun test src/transcript/matrix      also the YouTube source
 *   MATRIX=1 PG_CONTAINER=pgvector-db bun test src/transcript/matrix   also stops the database
 *   MATRIX=1 SOAK_MINUTES=30 bun test src/transcript/matrix -t soak
 *
 * Opt-in because it starts processes, needs Postgres and (for the DB case) stops a container.
 */
const enabled = process.env.MATRIX === '1';
const run = enabled ? describe : describe.skip;

const YOUTUBE_URL = process.env.YOUTUBE_URL ?? 'https://www.youtube.com/watch?v=7ARBJQn6QkM';
const SOURCES: StartMeetingInput['source'][] = process.env.MATRIX_YOUTUBE === '1' ? ['live', 'youtube'] : ['live'];
const BACKEND_DIR = path.resolve(import.meta.dir, '../../../backend/server');
const CHUNK_MS = 100;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}
--- backend output ---
${backend?.logs ?? ''}
--- fake deepgram: connections=${deepgram.connections} audioSeconds=${deepgram.audioSeconds} refuse=${deepgram.refuse}`);
}

const deepgram = new FakeDeepgram();
let backend: BackendProcess;

/** The account every scenario runs as. The backend needs a signed-in user for everything. */
let token = '';
const authed = (url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } });

/** One app window: a service plus everything it was told. */
class Window {
  readonly events: TranscriptEvent[] = [];
  readonly service: MeetingService;
  private mic: ReturnType<typeof setInterval> | null = null;

  constructor(url: string) {
    const api = new BackendApi(url);
    api.setToken(token);
    this.service = new MeetingService(api, {
      pollMs: 300,
      drainMs: 800,
      drainMaxMs: 8_000,
      quitEndTimeoutMs: 15_000,
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

  get lastStatus(): StreamStatus | undefined {
    return this.statuses.at(-1);
  }

  speech(): TranscriptSegment[] {
    return this.segments.filter((s) => s.source !== 'gap');
  }

  gaps(): TranscriptSegment[] {
    return this.segments.filter((s) => s.source === 'gap');
  }

  async begin(source: StartMeetingInput['source'], title: string): Promise<Meeting> {
    const input: StartMeetingInput =
      source === 'live' ? { source, title } : { source, title, url: YOUTUBE_URL, maxSeconds: 600 };
    const meeting = await this.service.start(input);
    if (source === 'live') this.startMic();
    return meeting;
  }

  /** What a microphone does: 100 ms of 16 kHz mono PCM every 100 ms. */
  startMic(): void {
    this.stopMic();
    this.mic = setInterval(() => this.service.sendAudio(new Uint8Array(3200).fill(1)), CHUNK_MS);
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

/** The log as the server holds it: a fresh connection replaying from the first segment. */
async function replay(meetingId: string, base = backend.url): Promise<number[]> {
  const seqs: number[] = [];
  const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/meetings/${meetingId}/stream?after=0`, {
    headers: { authorization: `Bearer ${token}` },
  } as unknown as string[]);
  let lastFrame = Date.now();
  socket.onmessage = (event) => {
    lastFrame = Date.now();
    const frame = JSON.parse(String(event.data)) as { type: string; seq?: number };
    if (frame.type === 'segment') seqs.push(frame.seq!);
  };
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error('replay socket failed'));
  });
  await until(() => Date.now() - lastFrame > 600, 10_000, 'replay to go quiet');
  socket.close();
  return seqs;
}

const seqsOf = (segments: TranscriptSegment[]) => segments.map((s) => s.seq);

/** Delivered in order, no repeats, no holes. */
function expectCleanLog(segments: TranscriptSegment[]): void {
  const seqs = seqsOf(segments);
  expect(seqs.length).toBeGreaterThan(0);
  expect(seqs).toEqual(seqs.map((_, i) => seqs[0]! + i));
  expect(new Set(seqs).size).toBe(seqs.length);
}

async function meetingStatus(id: string): Promise<Meeting['status']> {
  const response = await authed(`${backend.url}/meetings/${id}`);
  return ((await response.json()) as Meeting).status;
}

/** The client holds exactly what the server stored. */
async function expectMatchesServer(window: Window, meetingId: string): Promise<void> {
  expectCleanLog(window.segments);
  expect(seqsOf(window.segments)).toEqual(await replay(meetingId));
}

const windows: Window[] = [];
function open(): Window {
  const window = new Window(backend.url);
  windows.push(window);
  return window;
}

beforeAll(async () => {
  if (!enabled) return;
  await deepgram.start();
  backend = new BackendProcess(BACKEND_DIR, { DEEPGRAM_API_KEY: 'matrix', DEEPGRAM_WS_URL: deepgram.url });
  await backend.start();
  const signUp = new BackendApi(backend.url);
  const account = await signUp.signUp({
    name: 'Matrix',
    email: `matrix-${Date.now()}@example.com`,
    password: 'matrix-password-123',
  });
  token = account.token;
}, 60_000);

afterEach(async () => {
  for (const window of windows.splice(0)) {
    window.close();
  }
  if (!enabled) return;
  deepgram.refuse = false;
  // Leave nothing running for the next scenario.
  const running = (await (await authed(`${backend.url}/meetings`).catch(() => null))?.json().catch(() => null)) as
    | { meetings: Meeting[] }
    | null;
  for (const meeting of running?.meetings ?? []) {
    if (meeting.status !== 'ended') await authed(`${backend.url}/meetings/${meeting.id}/end`, { method: 'POST' }).catch(() => undefined);
  }
}, 60_000);

afterAll(async () => {
  if (!enabled) return;
  await backend?.stop();
  await deepgram.stop();
});

for (const source of SOURCES) {
  run(`failure matrix · ${source} source`, () => {
    test('baseline: a meeting streams, ends, and the client holds exactly what the server stored', async () => {
      const window = open();
      const meeting = await window.begin(source, `matrix baseline ${source}`);
      await until(() => window.speech().length >= 3, 30_000, 'three segments');
      await window.service.end(meeting.id);
      await until(() => window.lastStatus === 'ended', 20_000, 'ended status');
      expect(await meetingStatus(meeting.id)).toBe('ended');
      await expectMatchesServer(window, meeting.id);
    }, 90_000);

    test('backend crash mid-meeting: the client reconnects, the orphan is ended, nothing repeats, a new meeting can start', async () => {
      const window = open();
      const meeting = await window.begin(source, `matrix crash ${source}`);
      await until(() => window.speech().length >= 2, 30_000, 'two segments before the crash');
      const before = window.segments.length;

      backend.kill();
      await until(() => window.statuses.includes('reconnecting'), 15_000, 'reconnecting status');
      window.stopMic();
      await sleep(1_000);
      await backend.start();

      // Boot ends live meetings nobody holds; the heartbeat grace can delay it.
      await until(() => window.lastStatus === 'ended', 120_000, 'the orphaned meeting to be reported ended');
      expect(await meetingStatus(meeting.id)).toBe('ended');
      expect(window.segments.length).toBeGreaterThanOrEqual(before);
      await expectMatchesServer(window, meeting.id);

      const next = open();
      const second = await next.begin(source, `matrix after crash ${source}`);
      await until(() => next.speech().length >= 1, 30_000, 'a segment from the new meeting');
      await next.service.end(second.id);
    }, 240_000);

    test('Deepgram connection drops: it reconnects, resends unheard audio and keeps the same meeting', async () => {
      const window = open();
      const meeting = await window.begin(source, `matrix deepgram drop ${source}`);
      await until(() => window.speech().length >= 2, 30_000, 'two segments');
      const before = window.speech().length;

      const connections = deepgram.connections;
      deepgram.dropAll();
      await until(() => deepgram.connections > connections, 30_000, 'a new Deepgram connection');
      await until(() => window.speech().length >= before + 2, 30_000, 'speech after the reconnect');
      expect(await meetingStatus(meeting.id)).toBe('live');

      await window.service.end(meeting.id);
      await until(() => window.lastStatus === 'ended', 20_000, 'ended status');
      await expectMatchesServer(window, meeting.id);
    }, 120_000);

    test('Deepgram unreachable for a few seconds: audio is held and resent, meeting survives', async () => {
      const window = open();
      const meeting = await window.begin(source, `matrix deepgram outage ${source}`);
      await until(() => window.speech().length >= 2, 30_000, 'two segments');
      const before = window.speech().length;

      deepgram.refuse = true;
      deepgram.dropAll();
      await sleep(5_000);
      deepgram.refuse = false;

      await until(() => window.speech().length >= before + 2, 60_000, 'speech after the outage');
      expect(await meetingStatus(meeting.id)).toBe('live');
      await window.service.end(meeting.id);
      await until(() => window.lastStatus === 'ended', 20_000, 'ended status');
      await expectMatchesServer(window, meeting.id);
    }, 150_000);

    test('Deepgram down for good: the meeting ends cleanly and keeps what it had', async () => {
      const window = open();
      const meeting = await window.begin(source, `matrix deepgram dead ${source}`);
      await until(() => window.speech().length >= 2, 30_000, 'two segments');

      deepgram.refuse = true;
      deepgram.dropAll();
      await until(() => window.lastStatus === 'ended', 120_000, 'the meeting to end after reconnects run out');
      expect(await meetingStatus(meeting.id)).toBe('ended');
      expect(window.speech().length).toBeGreaterThanOrEqual(2);
      await expectMatchesServer(window, meeting.id);
    }, 200_000);

    test('app closed and reopened: the meeting keeps its transcript, a new window replays it and follows on', async () => {
      const first = open();
      const meeting = await first.begin(source, `matrix reopen ${source}`);
      await until(() => first.speech().length >= 2, 30_000, 'two segments');
      const seen = first.segments.length;
      first.close();

      const second = open();
      await second.service.subscribe(meeting.id);
      await until(() => second.segments.length >= seen, 20_000, 'the replay to catch up');
      expect(seqsOf(second.segments).slice(0, seen)).toEqual(seqsOf(first.segments).slice(0, seen));
      expectCleanLog(second.segments);
      expect(second.service.activeIsOwned).toBe(false);

      // Quitting from a window that only watches must not end someone else's meeting.
      await second.service.endOwnedMeeting();
      expect(await meetingStatus(meeting.id)).toBe('live');
      await authed(`${backend.url}/meetings/${meeting.id}/end`, { method: 'POST' });
    }, 120_000);

    test('quitting the app that started the meeting ends it on the server', async () => {
      const window = open();
      const meeting = await window.begin(source, `matrix quit ${source}`);
      await until(() => window.speech().length >= 2, 30_000, 'two segments');
      expect(window.service.hasOwnedLiveMeeting).toBe(true);

      await window.service.endOwnedMeeting();
      expect(await meetingStatus(meeting.id)).toBe('ended');
      await expectMatchesServer(window, meeting.id);
    }, 90_000);
  });
}

run('failure matrix · microphone', () => {
  test('mic goes silent (unplugged) then returns: the meeting stays live and resumes', async () => {
    const window = open();
    const meeting = await window.begin('live', 'matrix mic unplugged');
    await until(() => window.speech().length >= 2, 30_000, 'two segments');

    window.stopMic();
    await sleep(6_000);
    expect(await meetingStatus(meeting.id)).toBe('live');
    const before = window.speech().length;

    window.startMic();
    await until(() => window.speech().length >= before + 2, 30_000, 'speech after the mic returned');
    await window.service.end(meeting.id);
    await until(() => window.lastStatus === 'ended', 20_000, 'ended status');
    await expectMatchesServer(window, meeting.id);
  }, 120_000);

  test('the audio link drops (backend socket closes): audio reconnects and later speech arrives', async () => {
    const window = open();
    const conns = deepgram.connections;
    const secs = deepgram.audioSeconds;
    const meeting = await window.begin('live', 'matrix audio link');
    try {
      await until(() => window.speech().length >= 2, 30_000, 'two segments');
    } catch (error) {
      console.log('DIAG', JSON.stringify({ statuses: window.statuses, segments: window.segments.length, meeting: await meetingStatus(meeting.id).catch((e) => String(e)), newConns: deepgram.connections - conns, newSecs: deepgram.audioSeconds - secs, events: window.events.map((e) => e.type), direct: await authed(`${backend.directUrl}/meetings/${meeting.id}`).then((r) => r.json()).catch((e) => String(e)), directSegments: await replay(meeting.id, backend.directUrl).then((q) => q.length).catch((e) => String(e)) }));
      throw error;
    }
    const before = window.speech().length;

    // A network blip between app and backend: the stream and audio sockets both die.
    backend.dropConnections();
    await until(() => window.speech().length >= before + 2, 60_000, 'speech after the blip');
    expect(await meetingStatus(meeting.id)).toBe('live');
    await window.service.end(meeting.id);
    await until(() => window.lastStatus === 'ended', 20_000, 'ended status');
    await expectMatchesServer(window, meeting.id);
  }, 120_000);
});

run('failure matrix · second device', () => {
  test('a second device on the same account follows a live meeting started elsewhere: same transcript, no audio, and it cannot end it by leaving', async () => {
    const first = open();
    const conns = deepgram.connections;
    const meeting = await first.begin('live', 'matrix second device');
    await until(() => first.speech().length >= 2, 30_000, 'two segments on the first device');
    expect(deepgram.connections - conns).toBe(1);

    const second = open();
    await second.service.subscribe(meeting.id);
    await until(() => second.speech().length >= first.speech().length, 30_000, 'the second device to catch up');
    expect(second.service.activeIsOwned).toBe(false);
    expect(second.service.sendAudio(new Uint8Array(3200))).toBe(false);

    // It lists the chat the meeting started with, as it would for "Open chat".
    const chats = await second.service.api.listChats(meeting.id);
    expect(chats.length).toBeGreaterThanOrEqual(1);
    expect(chats.every((chat) => chat.meetingId === meeting.id)).toBe(true);

    // Following added no transcription connection, and leaving does not end the meeting.
    await second.service.endOwnedMeeting();
    second.service.unsubscribe();
    expect(deepgram.connections - conns).toBe(1);
    expect(await meetingStatus(meeting.id)).toBe('live');
    const before = first.speech().length;
    await until(() => first.speech().length >= before + 2, 30_000, 'the first device still hearing speech');

    await first.service.end(meeting.id);
    await until(() => first.lastStatus === 'ended', 20_000, 'ended status');
    await expectMatchesServer(first, meeting.id);
  }, 120_000);
});

const container = process.env.PG_CONTAINER;
(enabled && container ? describe : describe.skip)('failure matrix · database stop', () => {
  test('the database stops mid-meeting and comes back: the stream degrades, then catches up with nothing lost', async () => {
    const window = open();
    const meeting = await window.begin('live', 'matrix db stop');
    await until(() => window.speech().length >= 2, 30_000, 'two segments');

    await dockerCommand('stop', container!);
    try {
      await sleep(8_000);
    } finally {
      await dockerCommand('start', container!);
    }
    await until(async () => (await authed(`${backend.url}/healthz`).catch(() => null))?.ok === true, 60_000, 'backend healthz');
    const before = window.speech().length;

    await until(() => window.speech().length >= before + 3, 90_000, 'speech after the database returned');
    expect(await meetingStatus(meeting.id)).toBe('live');
    await window.service.end(meeting.id);
    await until(() => window.lastStatus === 'ended', 30_000, 'ended status');
    await expectMatchesServer(window, meeting.id);
  }, 240_000);
});

const soakMinutes = Number(process.env.SOAK_MINUTES ?? 0);
(enabled && soakMinutes > 0 ? describe : describe.skip)('failure matrix · soak', () => {
  test(`soak: ${soakMinutes} minute live meeting stays gapless and the backend does not grow`, async () => {
    const window = open();
    const meeting = await window.begin('live', 'matrix soak');
    await until(() => window.speech().length >= 3, 30_000, 'three segments');
    const startRss = rssMb(backend.pid);
    const deadline = Date.now() + soakMinutes * 60_000;
    let peak = startRss;
    while (Date.now() < deadline) {
      await sleep(30_000);
      const rss = rssMb(backend.pid);
      peak = Math.max(peak, rss);
      console.log(
        `soak ${Math.round((Date.now() - (deadline - soakMinutes * 60_000)) / 60_000)}m: segments=${window.segments.length} backendRss=${rss}MB status=${window.lastStatus}`,
      );
    }
    expect(window.statuses.filter((s) => s === 'reconnecting')).toEqual([]);
    expect(window.gaps()).toEqual([]);
    expect(peak - startRss).toBeLessThan(150);
    await window.service.end(meeting.id);
    await until(() => window.lastStatus === 'ended', 30_000, 'ended status');
    await expectMatchesServer(window, meeting.id);
  }, (soakMinutes + 5) * 60_000);
});
