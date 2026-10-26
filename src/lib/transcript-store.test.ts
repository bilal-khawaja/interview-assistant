import { beforeEach, describe, expect, test } from 'bun:test';
import type {
  ApiResult,
  Meeting,
  MeetingChangedEvent,
  StartMeetingInput,
  TranscriptResetEvent,
  TranscriptSegment,
  TranscriptSegmentEvent,
  TranscriptStatusEvent,
} from '../types/transcript';
import {
  BACKEND_URL_KEY,
  MIC_DEVICE_KEY,
  TranscriptStore,
  type MicStarter,
  type TranscriptApi,
} from './transcript-store';

const meeting = (over: Partial<Meeting> = {}): Meeting => ({
  id: 'm1',
  title: 'test',
  status: 'live',
  source: 'live',
  startedAt: null,
  endedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
});

const segment = (seq: number, text = `s${seq}`): TranscriptSegment => ({
  seq,
  text,
  startMs: seq * 1000,
  endMs: seq * 1000 + 900,
  source: 'deepgram',
  speakerKey: 'spk_0',
  speaker: null,
  createdAt: '2026-01-01T00:00:00Z',
});

class FakeApi implements TranscriptApi {
  handlers!: Parameters<TranscriptApi['listen']>[0];
  meetings: Meeting[] = [];
  healthy = true;
  startResult: ApiResult<{ meeting: Meeting }> = { meeting: meeting() };
  endResult: ApiResult<{ meeting: Meeting }> = { meeting: meeting({ status: 'ended' }) };
  subscribeResult: ApiResult<{ meeting: Meeting }> = { meeting: meeting() };
  activeResult: { meeting: Meeting | null; owned: boolean } = { meeting: null, owned: false };
  calls: string[] = [];
  audio: Uint8Array[] = [];
  startInputs: StartMeetingInput[] = [];
  configuredWith: string[] = [];
  startGate: Promise<void> | null = null;

  async configure(url: string): Promise<ApiResult<{ url: string }>> {
    this.configuredWith.push(url);
    if (!/^https?:\/\//.test(url)) return { error: 'backend URL must start with http:// or https://' };
    return { url: url.replace(/\/+$/, '') };
  }
  async health(): Promise<ApiResult<{ ok: true }>> {
    return this.healthy ? { ok: true } : { error: 'cannot reach the backend' };
  }
  async list(): Promise<ApiResult<{ meetings: Meeting[] }>> {
    return this.healthy ? { meetings: this.meetings } : { error: 'cannot reach the backend' };
  }
  async active() {
    return this.activeResult;
  }
  async start(input: StartMeetingInput) {
    this.calls.push('start');
    this.startInputs.push(input);
    await this.startGate;
    return this.startResult;
  }
  async end(id: string) {
    this.calls.push(`end:${id}`);
    return this.endResult;
  }
  async subscribe(id: string) {
    this.calls.push(`subscribe:${id}`);
    return this.subscribeResult;
  }
  async unsubscribe() {
    this.calls.push('unsubscribe');
  }
  async sendAudio(data: Uint8Array) {
    this.audio.push(data);
  }
  listen(handlers: Parameters<TranscriptApi['listen']>[0]) {
    this.handlers = handlers;
    return () => undefined;
  }
  // helpers to play the main process
  segment(e: TranscriptSegmentEvent) {
    this.handlers.onSegment(e);
  }
  status(e: TranscriptStatusEvent) {
    this.handlers.onStatus(e);
  }
  reset(e: TranscriptResetEvent) {
    this.handlers.onReset(e);
  }
  changed(e: MeetingChangedEvent) {
    this.handlers.onMeeting(e);
  }
}

class FakeMic implements MicStarter {
  starts: { deviceId?: string }[] = [];
  stops = 0;
  fail: unknown = null;
  options!: Parameters<MicStarter['start']>[0];
  async start(options: Parameters<MicStarter['start']>[0]) {
    if (this.fail) throw this.fail;
    this.starts.push({ deviceId: options.deviceId });
    this.options = options;
    return { stop: () => void this.stops++ };
  }
  describeError(error: unknown) {
    return `mic: ${String(error)}`;
  }
}

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

let api: FakeApi;
let mic: FakeMic;
let storage: MemoryStorage;
let store: TranscriptStore;

beforeEach(async () => {
  api = new FakeApi();
  mic = new FakeMic();
  storage = new MemoryStorage();
  store = new TranscriptStore(api, mic, storage);
  await store.init();
});

const chunk = (n: number) => new Uint8Array(3200).fill(n);

describe('TranscriptStore', () => {
  test('init configures the saved backend URL, checks health and loads meetings', async () => {
    storage.setItem(BACKEND_URL_KEY, 'http://example:4000');
    api = new FakeApi();
    api.meetings = [meeting({ id: 'old', status: 'ended' })];
    store = new TranscriptStore(api, mic, storage);
    await store.init();
    expect(api.configuredWith).toEqual(['http://example:4000']);
    expect(store.getState().backend).toBe('ok');
    expect(store.getState().meetings.map((m) => m.id)).toEqual(['old']);
  });

  test('an unreachable backend is reported, not thrown', async () => {
    api = new FakeApi();
    api.healthy = false;
    store = new TranscriptStore(api, mic, storage);
    await store.init();
    expect(store.getState().backend).toBe('down');
    expect(store.getState().backendError).toContain('cannot reach');
    expect(store.getState().listError).toContain('cannot reach');
  });

  test('starting a live meeting opens the mic first, remembers the device, and streams audio after', async () => {
    const started = await store.startMeeting({ source: 'live' }, 'headset-1');
    expect(started).toBe(true);
    expect(mic.starts).toEqual([{ deviceId: 'headset-1' }]);
    expect(storage.getItem(MIC_DEVICE_KEY)).toBe('headset-1');
    expect(store.getState()).toMatchObject({ runningHere: true, micActive: true, starting: false });

    mic.options.onChunk(chunk(1));
    await Promise.resolve();
    expect(api.audio.map((c) => c[0])).toEqual([1]);
  });

  test('audio captured while the start request is in flight is not lost and arrives in order', async () => {
    let release!: () => void;
    api.startGate = new Promise((resolve) => (release = resolve));
    const pending = store.startMeeting({ source: 'live' });
    await Promise.resolve();
    await Promise.resolve();
    mic.options.onChunk(chunk(1));
    mic.options.onChunk(chunk(2));
    expect(api.audio).toHaveLength(0);
    release();
    await pending;
    mic.options.onChunk(chunk(3));
    await Promise.resolve();
    expect(api.audio.map((c) => c[0])).toEqual([1, 2, 3]);
  });

  test('a microphone that cannot open stops the start before any meeting is created', async () => {
    mic.fail = 'denied';
    const started = await store.startMeeting({ source: 'live' });
    expect(started).toBe(false);
    expect(api.calls).not.toContain('start');
    expect(store.getState().error).toBe('mic: denied');
    expect(store.getState()).toMatchObject({ starting: false, runningHere: false, micActive: false });
  });

  test('a backend that refuses the start releases the microphone and explains a 409', async () => {
    api.startResult = { error: 'a meeting is already live', status: 409, meetingId: 'other' };
    const started = await store.startMeeting({ source: 'live' });
    expect(started).toBe(false);
    expect(mic.stops).toBe(1);
    expect(store.getState().error).toContain('already running');
    expect(store.getState().micActive).toBe(false);
  });

  test('a youtube meeting never touches the microphone', async () => {
    api.startResult = { meeting: meeting({ source: 'youtube' }) };
    await store.startMeeting({ source: 'youtube', url: 'https://youtu.be/x' });
    expect(mic.starts).toHaveLength(0);
    expect(store.getState().runningHere).toBe(true);
    expect(api.startInputs[0]).toEqual({ source: 'youtube', url: 'https://youtu.be/x' });
  });

  test('a second start while one runs here is ignored', async () => {
    await store.startMeeting({ source: 'live' });
    expect(await store.startMeeting({ source: 'live' })).toBe(false);
    expect(api.startInputs).toHaveLength(1);
  });

  test('segments append in order, ignore repeats, and reset clears them', async () => {
    await store.startMeeting({ source: 'live' });
    api.changed({ meeting: meeting() });
    api.segment({ meetingId: 'm1', segment: segment(1) });
    api.segment({ meetingId: 'm1', segment: segment(2) });
    api.segment({ meetingId: 'm1', segment: segment(2, 'dup') });
    api.segment({ meetingId: 'other', segment: segment(3) });
    expect(store.getState().segments.map((s) => s.text)).toEqual(['s1', 's2']);
    api.reset({ meetingId: 'm1' });
    expect(store.getState().segments).toEqual([]);
  });

  test('stream status and its detail are tracked for the open meeting only', async () => {
    await store.startMeeting({ source: 'live' });
    api.status({ meetingId: 'm1', status: 'degraded', detail: 'database unreachable' });
    expect(store.getState()).toMatchObject({ status: 'degraded', detail: 'database unreachable' });
    api.status({ meetingId: 'zzz', status: 'live' });
    expect(store.getState().status).toBe('degraded');
  });

  test('ending stops the mic, calls the backend, and frees the window for other meetings', async () => {
    await store.startMeeting({ source: 'live' });
    await store.endMeeting();
    expect(api.calls).toContain('end:m1');
    expect(mic.stops).toBe(1);
    expect(store.getState()).toMatchObject({ runningHere: false, micActive: false, ending: false });
    expect(store.getState().meeting?.status).toBe('ended');
  });

  test('a failed end keeps the meeting running here and shows the error', async () => {
    await store.startMeeting({ source: 'live' });
    api.endResult = { error: 'cannot reach the backend' };
    await store.endMeeting();
    expect(store.getState().error).toContain('cannot reach');
    expect(store.getState().runningHere).toBe(true);
  });

  test('the server ending the meeting stops the microphone and frees the window', async () => {
    await store.startMeeting({ source: 'live' });
    api.changed({ meeting: meeting({ status: 'ended' }) });
    expect(store.getState()).toMatchObject({ runningHere: false, micActive: false });
    expect(mic.stops).toBe(1);
  });

  test('ended status after the tail is delivered also frees the window', async () => {
    await store.startMeeting({ source: 'live' });
    api.status({ meetingId: 'm1', status: 'ended' });
    expect(store.getState().runningHere).toBe(false);
  });

  test('losing the microphone mid-meeting surfaces an error but keeps the meeting', async () => {
    await store.startMeeting({ source: 'live' });
    mic.options.onEnded('The microphone was disconnected.');
    expect(store.getState().error).toContain('disconnected');
    expect(store.getState()).toMatchObject({ micActive: false, runningHere: true });
  });

  test('a "cannot reach" notice clears itself once the stream is live again, other errors stay', async () => {
    await store.startMeeting({ source: 'live' });
    api.endResult = { error: 'cannot reach the backend at http://localhost:3000' };
    await store.endMeeting();
    expect(store.getState().error).toContain('cannot reach');
    api.status({ meetingId: 'm1', status: 'live' });
    expect(store.getState().error).toBeNull();
    expect(store.getState().backend).toBe('ok');

    mic.options.onEnded('The microphone was disconnected.');
    api.status({ meetingId: 'm1', status: 'live' });
    expect(store.getState().error).toContain('disconnected');
  });

  test('a successful meeting-list refresh also clears a stale connection error', async () => {
    await store.startMeeting({ source: 'live' });
    api.endResult = { error: 'the backend at http://x did not answer in time' };
    await store.endMeeting();
    expect(store.getState().error).not.toBeNull();
    await store.refreshMeetings();
    expect(store.getState().error).toBeNull();
  });

  test('mic level updates reach the state', async () => {
    await store.startMeeting({ source: 'live' });
    mic.options.onLevel(0.4);
    expect(store.getState().micLevel).toBe(0.4);
  });

  test('opening a stored meeting subscribes and clears the previous transcript', async () => {
    api.subscribeResult = { meeting: meeting({ id: 'old', status: 'ended', source: null }) };
    api.changed({ meeting: meeting({ id: 'x' }) });
    api.segment({ meetingId: 'x', segment: segment(1) });
    await store.openMeeting('old');
    expect(api.calls).toContain('subscribe:old');
    expect(store.getState().meeting?.id).toBe('old');
    expect(store.getState().segments).toEqual([]);
  });

  test('opening another meeting is refused while one runs here', async () => {
    await store.startMeeting({ source: 'live' });
    await store.openMeeting('old');
    expect(api.calls).not.toContain('subscribe:old');
    await store.closeMeeting();
    expect(api.calls).not.toContain('unsubscribe');
    expect(store.getState().meeting?.id).toBe('m1');
  });

  test('closing a stored meeting unsubscribes and clears the view', async () => {
    await store.openMeeting('m1');
    await store.closeMeeting();
    expect(api.calls).toContain('unsubscribe');
    expect(store.getState().meeting).toBeNull();
  });

  test('a reloaded window resumes the meeting this app owns, including the microphone', async () => {
    storage.setItem(MIC_DEVICE_KEY, 'headset-1');
    api = new FakeApi();
    api.activeResult = { meeting: meeting(), owned: true };
    mic = new FakeMic();
    store = new TranscriptStore(api, mic, storage);
    await store.init();
    expect(api.calls).toContain('subscribe:m1');
    expect(mic.starts).toEqual([{ deviceId: 'headset-1' }]);
    expect(store.getState()).toMatchObject({ runningHere: true, micActive: true });
    mic.options.onChunk(chunk(9));
    await Promise.resolve();
    expect(api.audio).toHaveLength(1);
  });

  test('a reloaded window only watches a meeting it does not own', async () => {
    api = new FakeApi();
    api.activeResult = { meeting: meeting(), owned: false };
    mic = new FakeMic();
    store = new TranscriptStore(api, mic, storage);
    await store.init();
    expect(mic.starts).toHaveLength(0);
    expect(store.getState().runningHere).toBe(false);
    expect(store.getState().meeting?.id).toBe('m1');
  });

  test('setBackendUrl saves a valid URL and rejects a bad one without changing anything', async () => {
    expect(await store.setBackendUrl('http://localhost:4000/')).toBeNull();
    expect(storage.getItem(BACKEND_URL_KEY)).toBe('http://localhost:4000');
    expect(store.getState().backendUrl).toBe('http://localhost:4000');

    expect(await store.setBackendUrl('nope')).toContain('http');
    expect(store.getState().backendUrl).toBe('http://localhost:4000');
  });

  test('subscribers are notified and can unsubscribe', async () => {
    let calls = 0;
    const off = store.subscribe(() => calls++);
    api.changed({ meeting: meeting() });
    expect(calls).toBeGreaterThan(0);
    const seen = calls;
    off();
    api.changed({ meeting: meeting({ id: 'z' }) });
    expect(calls).toBe(seen);
  });
});
