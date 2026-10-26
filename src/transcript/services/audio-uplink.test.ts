import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { FakeBackend, until } from '../testing/fake-backend';
import { AudioUplink, type UplinkState } from './audio-uplink';

let backend: FakeBackend;
let uplink: AudioUplink | null = null;

beforeEach(() => {
  backend = new FakeBackend().start();
});
afterEach(async () => {
  uplink?.close();
  uplink = null;
  await backend.stop();
});

const chunk = (fill: number, size = 100) => new Uint8Array(size).fill(fill);

function open(meetingId: string, extra: Partial<ConstructorParameters<typeof AudioUplink>[0]> = {}) {
  const states: UplinkState[] = [];
  uplink = new AudioUplink({
    baseUrl: backend.url,
    meetingId,
    onState: (s) => states.push(s),
    reconnect: { baseMs: 10, maxMs: 40 },
    ...extra,
  });
  uplink.start();
  return states;
}

describe('AudioUplink', () => {
  test('audio pushed before the socket opens is sent in order once it does', async () => {
    const meeting = backend.addMeeting({ source: 'live' });
    open(meeting.id);
    uplink!.push(chunk(1));
    uplink!.push(chunk(2));
    uplink!.push(chunk(3));
    await until(() => backend.audioFrames.length === 3);
    expect(backend.audioFrames.map((f) => f[0])).toEqual([1, 2, 3]);
  });

  test('audio after the socket is open goes straight through', async () => {
    const meeting = backend.addMeeting({ source: 'live' });
    const states = open(meeting.id);
    await until(() => uplink!.isOpen);
    uplink!.push(chunk(7, 3200));
    await until(() => backend.audioFrames.length === 1);
    expect(backend.audioFrames[0]!.length).toBe(3200);
    expect(states).toEqual(['connecting', 'open']);
  });

  test('a dropped connection reconnects and later audio still arrives', async () => {
    const meeting = backend.addMeeting({ source: 'live' });
    const states = open(meeting.id);
    await until(() => uplink!.isOpen);
    uplink!.push(chunk(1));
    await until(() => backend.audioFrames.length === 1);

    for (const ws of backend.audios) ws.close(1006, 'drop');
    await until(() => states.includes('reconnecting'));
    uplink!.push(chunk(2)); // queued while down
    await until(() => backend.audioFrames.length === 2, 3_000);
    expect(backend.audioFrames.map((f) => f[0])).toEqual([1, 2]);
  });

  test('keeps only the newest audio while down and counts what it dropped', async () => {
    const meeting = backend.addMeeting({ source: 'live' });
    const port = await backend.kill();
    open(meeting.id, { maxQueuedBytes: 300 });
    for (let i = 1; i <= 6; i++) uplink!.push(chunk(i));
    expect(uplink!.droppedBytes).toBe(300);
    backend.start(port);
    await until(() => backend.audioFrames.length === 3, 3_000);
    expect(backend.audioFrames.map((f) => f[0])).toEqual([4, 5, 6]);
  });

  test('close stops sending and stops reconnecting', async () => {
    const meeting = backend.addMeeting({ source: 'live' });
    const states = open(meeting.id);
    await until(() => uplink!.isOpen);
    uplink!.close();
    uplink!.push(chunk(9));
    await new Promise((r) => setTimeout(r, 100));
    expect(backend.audioFrames).toHaveLength(0);
    expect(states.at(-1)).toBe('closed');
  });

  test('a meeting that refuses audio is retried with backoff, not hammered', async () => {
    const meeting = backend.addMeeting({ status: 'ended' });
    const states = open(meeting.id, { reconnect: { baseMs: 50, maxMs: 50 } });
    await new Promise((r) => setTimeout(r, 300));
    expect(states).toContain('reconnecting');
    expect(backend.audios.size).toBe(0);
  });
});
