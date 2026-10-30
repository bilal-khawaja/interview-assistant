import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { FakeBackend, until } from '../testing/fake-backend';
import { BackendApi, BackendApiError } from './backend-api.client';
import { MeetingService, type TranscriptEvent } from './meeting.service';

let backend: FakeBackend;
let service: MeetingService;
let events: TranscriptEvent[];

beforeEach(() => {
  backend = new FakeBackend().start();
  service = make();
});
afterEach(async () => {
  service.dispose();
  await backend.stop();
});

function make(options: ConstructorParameters<typeof MeetingService>[1] = {}) {
  events = [];
  const s = new MeetingService(new BackendApi(backend.url), {
    pollMs: 30,
    drainMs: 60,
    drainMaxMs: 1_000,
    streamOptions: { reconnect: { baseMs: 10, maxMs: 40 } },
    uplinkOptions: { reconnect: { baseMs: 10, maxMs: 40 } },
    ...options,
  });
  s.onEvent((e) => events.push(e));
  return s;
}

const texts = () => events.flatMap((e) => (e.type === 'segment' ? [e.event.segment.text] : []));
const statuses = () => events.flatMap((e) => (e.type === 'status' ? [e.event.status] : []));
const audio = (fill: number) => new Uint8Array(3200).fill(fill);

describe('MeetingService joining through a link', () => {
  const TOKEN = 'k3J9_aZx-0pQwErTyUiOpAsDfGhJkLzXcVbNm12345A';
  const shared = () => {
    const meeting = backend.addMeeting({ title: 'theirs', source: 'live' });
    backend.invites.set(TOKEN, meeting.id);
    return meeting;
  };

  test('joining follows the transcript as a participant and carries this app\'s microphone', async () => {
    const meeting = shared();
    const joined = await service.join(TOKEN, true);
    expect(joined).toMatchObject({ id: meeting.id, role: 'participant' });
    expect(service.activeIsOwned).toBe(false);
    expect(service.activeIsSpeaking).toBe(true);

    await until(() => backend.streams.size === 1 && backend.audios.size === 1);
    expect(service.sendAudio(audio(3))).toBe(true);
    await until(() => backend.audioFrames.length === 1);
    backend.push(meeting.id, 'from the host');
    await until(() => texts().length === 1);
  });

  test('joining to listen only opens no audio path', async () => {
    shared();
    await service.join(TOKEN, false);
    await until(() => backend.streams.size === 1);
    expect(backend.audios.size).toBe(0);
    expect(service.activeIsSpeaking).toBe(false);
    expect(service.sendAudio(audio(1))).toBe(false);
  });

  test('a link the backend does not know is refused and nothing is followed', async () => {
    shared();
    await expect(service.join('x'.repeat(43), true)).rejects.toMatchObject({ status: 404 });
    expect(service.activeMeeting).toBeNull();
  });

  test('re-subscribing after a window reload keeps the role and the microphone link', async () => {
    const meeting = shared();
    await service.join(TOKEN, true);
    await until(() => backend.audios.size === 1);
    await service.subscribe(meeting.id);
    expect(service.activeIsSpeaking).toBe(true);
    await until(() => backend.audios.size >= 1 && backend.streams.size === 1);
    expect(service.sendAudio(audio(1))).toBe(true);
  });

  test('leaving closes the microphone, tells the backend and stops following', async () => {
    const meeting = shared();
    await service.join(TOKEN, true);
    await until(() => backend.audios.size === 1);
    await service.leave(meeting.id);
    expect(backend.leaves).toEqual([meeting.id]);
    expect(service.activeMeeting).toBeNull();
    await until(() => backend.audios.size === 0 && backend.streams.size === 0);
  });

  test('leaving a meeting the account is already out of is not an error', async () => {
    const meeting = shared();
    await service.join(TOKEN, false);
    backend.removeParticipant(meeting.id);
    await service.leave(meeting.id);
    expect(service.activeMeeting).toBeNull();
  });

  test('being removed by the owner is reported once and everything is closed', async () => {
    const meeting = shared();
    await service.join(TOKEN, true);
    await until(() => backend.audios.size === 1 && backend.streams.size === 1);
    backend.removeParticipant(meeting.id);
    await until(() => statuses().includes('removed'));
    expect(statuses().filter((s) => s === 'removed')).toHaveLength(1);
    expect(service.activeMeeting).toBeNull();
    await until(() => backend.audios.size === 0 && backend.streams.size === 0);
  });

  test('the owner ending the meeting ends it for a participant too', async () => {
    const meeting = shared();
    await service.join(TOKEN, true);
    await until(() => backend.streams.size === 1);
    backend.end(meeting.id);
    await until(() => statuses().includes('ended'));
    expect(service.activeMeeting).toBeNull();
  });
});

describe('MeetingService', () => {
  test('starting a live meeting follows its transcript and carries microphone audio', async () => {
    const meeting = await service.start({ source: 'live', title: 'mic' });
    expect(meeting.status).toBe('live');
    expect(backend.starts).toEqual([{ source: 'live', title: 'mic' }]);

    await until(() => backend.streams.size === 1 && backend.audios.size === 1);
    expect(service.sendAudio(audio(5))).toBe(true);
    await until(() => backend.audioFrames.length === 1);

    backend.push(meeting.id, 'hello there');
    await until(() => texts().length === 1);
    expect(texts()).toEqual(['hello there']);
    expect(statuses()).toContain('live');
  });

  test('a youtube meeting follows the transcript but opens no audio path', async () => {
    const meeting = await service.start({ source: 'youtube', url: 'https://youtu.be/x' });
    await until(() => backend.streams.size === 1);
    expect(backend.audios.size).toBe(0);
    expect(service.sendAudio(audio(1))).toBe(false);
    backend.push(meeting.id, 'from video');
    await until(() => texts().length === 1);
  });

  test('ending stops audio, ends the meeting on the backend, delivers the tail and reports ended', async () => {
    const meeting = await service.start({ source: 'live' });
    await until(() => backend.audios.size === 1);
    backend.push(meeting.id, 'first');
    await until(() => texts().length === 1);

    const ended = await service.end(meeting.id);
    backend.push(meeting.id, 'tail'); // still flushing on the server after end
    expect(ended.status).toBe('ended');
    expect(backend.ends).toBe(1);

    await until(() => statuses().includes('ended'));
    expect(texts()).toEqual(['first', 'tail']);
    expect(service.sendAudio(audio(1))).toBe(false);
    expect(service.activeMeeting).toBeNull();
    await until(() => backend.streams.size === 0 && backend.audios.size === 0);
  });

  test('a meeting that ends on the server is noticed by polling and reported ended', async () => {
    const meeting = await service.start({ source: 'youtube', url: 'https://youtu.be/x' });
    await until(() => backend.streams.size === 1);
    backend.push(meeting.id, 'a');
    backend.end(meeting.id);
    await until(() => statuses().includes('ended'));
    const changed = events.filter((e) => e.type === 'meeting' && e.event.meeting.status === 'ended');
    expect(changed.length).toBeGreaterThan(0);
    expect(texts()).toEqual(['a']);
  });

  test('subscribing to a finished meeting replays everything, then reports ended', async () => {
    const meeting = backend.addMeeting({ status: 'ended' });
    backend.push(meeting.id, 'one');
    backend.push(meeting.id, 'two');
    backend.push(meeting.id, 'three');
    await service.subscribe(meeting.id);
    await until(() => statuses().includes('ended'));
    expect(texts()).toEqual(['one', 'two', 'three']);
    expect(service.sendAudio(audio(1))).toBe(false);
  });

  test('following another meeting replaces the first and closes its connections', async () => {
    const a = backend.addMeeting({ status: 'ended' });
    const b = backend.addMeeting({ status: 'live' });
    backend.push(b.id, 'b1');
    await service.subscribe(b.id);
    await until(() => backend.streams.size === 1);
    await service.subscribe(a.id);
    await until(() => statuses().includes('ended'));
    await until(() => backend.streams.size === 0);
  });

  test('a second start is refused with the id of the meeting already live', async () => {
    const first = await service.start({ source: 'live' });
    const error = (await service.start({ source: 'live' }).catch((e) => e)) as BackendApiError;
    expect(error).toBeInstanceOf(BackendApiError);
    expect(error.status).toBe(409);
    expect(error.meetingId).toBe(first.id);
    expect(service.activeMeeting?.id).toBe(first.id);
  });

  test('an unreachable backend is a clear error, not a hang', async () => {
    await backend.kill();
    const error = (await service.start({ source: 'live' }).catch((e) => e)) as BackendApiError;
    expect(error.message).toContain('cannot reach the backend');
    expect(service.activeMeeting).toBeNull();
  });

  test('quitting ends a meeting this app started', async () => {
    const meeting = await service.start({ source: 'live' });
    await until(() => backend.audios.size === 1);
    expect(service.hasOwnedLiveMeeting).toBe(true);
    await service.endOwnedMeeting();
    expect(backend.meetings.get(meeting.id)!.status).toBe('ended');
    expect(service.hasOwnedLiveMeeting).toBe(false);
  });

  test('quitting leaves a meeting this app only watched alone', async () => {
    const meeting = backend.addMeeting({ status: 'live' });
    await service.subscribe(meeting.id);
    expect(service.hasOwnedLiveMeeting).toBe(false);
    await service.endOwnedMeeting();
    expect(backend.ends).toBe(0);
    expect(backend.meetings.get(meeting.id)!.status).toBe('live');
  });

  test('quitting does not hang when the backend never answers the end call', async () => {
    const slow = make({ quitEndTimeoutMs: 150 });
    await slow.start({ source: 'live' });
    await until(() => backend.audios.size === 1);
    await backend.kill();
    const started = Date.now();
    await slow.endOwnedMeeting();
    expect(Date.now() - started).toBeLessThan(2_000);
    slow.dispose();
  });

  test('a reloaded window can follow the same meeting again from the start', async () => {
    const meeting = await service.start({ source: 'live' });
    backend.push(meeting.id, 'before reload');
    await until(() => texts().length === 1);

    events.length = 0;
    await service.subscribe(meeting.id); // what the window does on load
    await until(() => texts().length === 1);
    expect(texts()).toEqual(['before reload']);
    expect(service.hasOwnedLiveMeeting).toBe(true);
    await until(() => backend.audios.size === 1);
  });

  test('losing the stream mid-meeting resumes without gaps or repeats', async () => {
    const meeting = await service.start({ source: 'youtube', url: 'https://youtu.be/x' });
    await until(() => backend.streams.size === 1);
    backend.push(meeting.id, 'a');
    backend.push(meeting.id, 'b');
    await until(() => texts().length === 2);
    backend.dropStreams();
    backend.push(meeting.id, 'c');
    await until(() => texts().length === 3);
    expect(texts()).toEqual(['a', 'b', 'c']);
    expect(statuses()).toContain('reconnecting');
  });

  test('configure normalizes the URL and rejects junk', () => {
    expect(service.configure(' http://localhost:4000/ ')).toBe('http://localhost:4000');
    expect(service.api.url).toBe('http://localhost:4000');
    expect(() => service.configure('ftp://nope')).toThrow();
  });

  test('a listener that throws does not stop delivery to the others', async () => {
    const meeting = backend.addMeeting();
    service.onEvent(() => {
      throw new Error('window gone');
    });
    await service.subscribe(meeting.id);
    await until(() => backend.streams.size === 1);
    backend.push(meeting.id, 'x');
    await until(() => texts().length === 1);
  });
});
