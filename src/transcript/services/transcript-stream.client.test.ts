import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { StreamStatus, TranscriptSegment } from '../../types/transcript';
import { FakeBackend, until } from '../testing/fake-backend';
import { TranscriptStreamClient } from './transcript-stream.client';

let backend: FakeBackend;
let client: TranscriptStreamClient | null = null;

beforeEach(() => {
  backend = new FakeBackend().start();
});
afterEach(async () => {
  client?.stop();
  client = null;
  await backend.stop();
});

function follow(meetingId: string, extra: Partial<ConstructorParameters<typeof TranscriptStreamClient>[0]> = {}) {
  const segments: TranscriptSegment[] = [];
  const statuses: StreamStatus[] = [];
  let resets = 0;
  client = new TranscriptStreamClient({
    baseUrl: backend.url,
    meetingId,
    onSegment: (s) => segments.push(s),
    onStatus: (s) => statuses.push(s),
    onReset: () => resets++,
    reconnect: { baseMs: 10, maxMs: 40 },
    ...extra,
  });
  client.start();
  return { segments, statuses, resets: () => resets };
}

describe('TranscriptStreamClient', () => {
  test('delivers history then live segments in order and reports live', async () => {
    const meeting = backend.addMeeting();
    backend.push(meeting.id, 'one');
    backend.push(meeting.id, 'two');
    const { segments, statuses } = follow(meeting.id);
    await until(() => segments.length === 2);
    backend.push(meeting.id, 'three');
    await until(() => segments.length === 3);

    expect(segments.map((s) => s.text)).toEqual(['one', 'two', 'three']);
    expect(segments.map((s) => s.seq)).toEqual([1, 2, 3]);
    expect(statuses[0]).toBe('connecting');
    expect(statuses).toContain('live');
  });

  test('a dropped connection resumes after the last sequence number with nothing lost or repeated', async () => {
    const meeting = backend.addMeeting();
    backend.push(meeting.id, 'a');
    backend.push(meeting.id, 'b');
    const { segments, statuses } = follow(meeting.id);
    await until(() => segments.length === 2);

    backend.dropStreams(1006);
    backend.push(meeting.id, 'c'); // arrives while the client is disconnected
    backend.push(meeting.id, 'd');
    await until(() => segments.length === 4);
    backend.push(meeting.id, 'e');
    await until(() => segments.length === 5);

    expect(segments.map((s) => s.text)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(statuses).toContain('reconnecting');
    expect(statuses.at(-1)).toBe('live');
    expect(backend.streamOpens.map((o) => o.after)).toEqual([0, 2]);
  });

  test('a segment the server repeats is delivered once', async () => {
    const meeting = backend.addMeeting();
    const { segments } = follow(meeting.id);
    await until(() => backend.streams.size === 1);
    const seg = backend.push(meeting.id, 'x');
    backend.broadcast({ type: 'segment', ...seg });
    backend.push(meeting.id, 'y');
    await until(() => segments.length === 2);
    expect(segments.map((s) => s.text)).toEqual(['x', 'y']);
  });

  test('degraded then recovered ends back at live', async () => {
    const meeting = backend.addMeeting();
    const { statuses } = follow(meeting.id);
    await until(() => backend.streams.size === 1);
    backend.broadcast({ type: 'degraded', reason: 'db' });
    await until(() => statuses.includes('degraded'));
    backend.broadcast({ type: 'recovered' });
    await until(() => statuses.at(-1) === 'live');
  });

  test('a cursor ahead of the server restarts from zero and tells the owner to clear', async () => {
    const meeting = backend.addMeeting();
    backend.push(meeting.id, 'a');
    backend.push(meeting.id, 'b');
    const { segments, resets } = follow(meeting.id, { after: 7 });
    await until(() => resets() === 1);
    await until(() => segments.length === 2);
    expect(segments.map((s) => s.text)).toEqual(['a', 'b']);
    expect(backend.streamOpens.map((o) => o.after)).toEqual([7, 0]);
  });

  test('silence past a few heartbeats is treated as a dead connection and reconnected', async () => {
    backend.heartbeatMs = 40;
    const meeting = backend.addMeeting();
    const { statuses } = follow(meeting.id, { silenceFactor: 2 });
    await until(() => statuses.includes('live'));
    await until(() => backend.streamOpens.length >= 2, 2_000);
    expect(statuses).toContain('reconnecting');
  });

  test('heartbeats keep a quiet connection alive', async () => {
    backend.heartbeatMs = 60;
    const meeting = backend.addMeeting();
    follow(meeting.id, { silenceFactor: 2 });
    await until(() => backend.streams.size === 1);
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 40));
      backend.broadcast({ type: 'heartbeat', at: new Date().toISOString() });
    }
    expect(backend.streamOpens).toHaveLength(1);
  });

  test('keeps retrying while the backend is down and connects when it returns', async () => {
    const meeting = backend.addMeeting();
    backend.push(meeting.id, 'a');
    const { segments, statuses } = follow(meeting.id);
    await until(() => segments.length === 1);

    const port = await backend.kill();
    await until(() => statuses.includes('reconnecting'));
    await new Promise((r) => setTimeout(r, 120)); // several failed attempts
    backend.start(port);
    backend.push(meeting.id, 'b');
    await until(() => segments.length === 2, 4_000);
    expect(segments.map((s) => s.text)).toEqual(['a', 'b']);
    expect(statuses.at(-1)).toBe('live');
  });

  test('a backend that is down at the start is retried, not fatal', async () => {
    const meeting = backend.addMeeting();
    backend.push(meeting.id, 'first');
    const port = await backend.kill();
    const { segments } = follow(meeting.id);
    await new Promise((r) => setTimeout(r, 100));
    backend.start(port);
    await until(() => segments.length === 1, 4_000);
  });

  test('stop ends the connection and never reconnects', async () => {
    const meeting = backend.addMeeting();
    const { statuses } = follow(meeting.id);
    await until(() => backend.streams.size === 1);
    client!.stop();
    await until(() => backend.streams.size === 0);
    await new Promise((r) => setTimeout(r, 120));
    expect(backend.streamOpens).toHaveLength(1);
    expect(statuses.at(-1)).toBe('live');
  });

  test('quietMs is 0 until connected, then counts up from the last activity', async () => {
    const meeting = backend.addMeeting();
    const { segments } = follow(meeting.id);
    expect(client!.quietMs()).toBe(0);
    await until(() => backend.streams.size === 1);
    backend.push(meeting.id, 'a');
    await until(() => segments.length === 1);
    await new Promise((r) => setTimeout(r, 60));
    expect(client!.quietMs()).toBeGreaterThanOrEqual(50);
  });

  test('garbage frames are ignored', async () => {
    const meeting = backend.addMeeting();
    const { segments } = follow(meeting.id);
    await until(() => backend.streams.size === 1);
    for (const ws of backend.streams) ws.send('not json {{');
    backend.push(meeting.id, 'ok');
    await until(() => segments.length === 1);
  });
});
