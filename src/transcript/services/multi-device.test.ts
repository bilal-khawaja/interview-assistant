import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { BackendChatMessage } from '../../types/meeting-chat';
import { FakeBackend, until } from '../testing/fake-backend';
import { BackendApi } from './backend-api.client';
import { MeetingChatService, type MeetingChatEvent } from './meeting-chat.service';
import { MeetingService, type TranscriptEvent } from './meeting.service';

/**
 * Two devices signed in as the same account: each is its own main process, with its own API
 * client, token, services and sockets, talking to one backend.
 */
class Device {
  readonly api: BackendApi;
  readonly meetings: MeetingService;
  readonly chats: MeetingChatService;
  readonly transcript: TranscriptEvent[] = [];
  readonly chatEvents: MeetingChatEvent[] = [];

  constructor(backend: FakeBackend, email: string) {
    this.api = new BackendApi(backend.url);
    this.api.setToken(backend.issueToken(email));
    const reconnect = { reconnect: { baseMs: 10, maxMs: 40 } };
    this.meetings = new MeetingService(this.api, {
      pollMs: 30,
      drainMs: 60,
      drainMaxMs: 1_000,
      streamOptions: reconnect,
      uplinkOptions: reconnect,
    });
    this.chats = new MeetingChatService(this.api, { streamOptions: reconnect });
    this.meetings.onEvent((event) => this.transcript.push(event));
    this.chats.onEvent((event) => this.chatEvents.push(event));
  }

  get texts(): string[] {
    return this.transcript.flatMap((e) => (e.type === 'segment' ? [e.event.segment.text] : []));
  }

  get statuses(): string[] {
    return this.transcript.flatMap((e) => (e.type === 'status' ? [e.event.status] : []));
  }

  chatTexts(chatId: string): string[] {
    return this.chatEvents.flatMap((e) => (e.type === 'message' && e.event.chatId === chatId ? [e.event.message.content] : []));
  }

  dispose(): void {
    this.meetings.dispose();
    this.chats.dispose();
  }
}

let backend: FakeBackend;
let a: Device;
let b: Device;

beforeEach(() => {
  backend = new FakeBackend().start();
  backend.requireAuth = true;
  backend.addAccount('ada@example.com', 'a long enough password');
  a = new Device(backend, 'ada@example.com');
  b = new Device(backend, 'ada@example.com');
});
afterEach(async () => {
  a.dispose();
  b.dispose();
  await backend.stop();
});

describe('a meeting started on another device', () => {
  test('the second device follows the transcript, history first, and sends no audio', async () => {
    const meeting = await a.meetings.start({ source: 'live', title: 'standup' });
    await until(() => backend.audios.size === 1);
    backend.push(meeting.id, 'before B joined');

    await b.meetings.subscribe(meeting.id);
    backend.push(meeting.id, 'after B joined');
    await until(() => b.texts.length === 2 && a.texts.length === 2);

    expect(b.texts).toEqual(['before B joined', 'after B joined']);
    expect(a.texts).toEqual(b.texts);

    // Only A's microphone link exists: B opened a transcript stream and nothing else.
    expect(backend.audios.size).toBe(1);
    expect(backend.streams.size).toBe(2);
    expect(b.meetings.sendAudio(new Uint8Array(3200))).toBe(false);
    expect(backend.audioFrames).toHaveLength(0);
  });

  test('B does not own the meeting: quitting B leaves it running, and A can still end it', async () => {
    const meeting = await a.meetings.start({ source: 'live', title: 'standup' });
    await b.meetings.subscribe(meeting.id);
    expect(a.meetings.activeIsOwned).toBe(true);
    expect(b.meetings.activeIsOwned).toBe(false);
    expect(b.meetings.hasOwnedLiveMeeting).toBe(false);

    await b.meetings.endOwnedMeeting();
    expect(backend.ends).toBe(0);
    expect(backend.meetings.get(meeting.id)?.status).toBe('live');

    await a.meetings.end(meeting.id);
    await until(() => b.statuses.includes('ended'));
    expect(backend.ends).toBe(1);
  });

  test('B notices the meeting end even though it did not end it', async () => {
    const meeting = await a.meetings.start({ source: 'live', title: 'standup' });
    await b.meetings.subscribe(meeting.id);
    backend.push(meeting.id, 'last words');
    await a.meetings.end(meeting.id);
    await until(() => b.statuses.includes('ended'));
    expect(b.texts).toEqual(['last words']);
    expect(b.meetings.activeMeeting).toBeNull();
  });

  test('B can list the meeting\'s chats and follow one that A made', async () => {
    const meeting = await a.meetings.start({ source: 'live', title: 'standup' });
    const chat = backend.addChat(meeting.id, 'Interview prep');

    const listed = await b.chats.list(meeting.id);
    expect(listed.map((c) => c.id)).toEqual([chat.id]);

    backend.pushChatMessage(chat.id, 'assistant', 'reply', 'earlier answer');
    b.chats.follow(meeting.id, chat.id);
    await until(() => b.chatTexts(chat.id).length === 1);
    expect(b.chatTexts(chat.id)).toEqual(['earlier answer']);
  });

  test('both devices see the same chat: what one sends, and the reply, reach both', async () => {
    const meeting = await a.meetings.start({ source: 'live', title: 'standup' });
    const chat = backend.addChat(meeting.id, 'shared');
    a.chats.follow(meeting.id, chat.id);
    b.chats.follow(meeting.id, chat.id);
    await until(() => backend.chatSockets.size === 2);

    await b.chats.send({ meetingId: meeting.id, chatId: chat.id, messageId: crypto.randomUUID(), text: 'from B', mode: 'followup' });
    expect(backend.chatPosts.map((p) => p.text)).toEqual(['from B']);

    // The backend puts the sender's message on the chat stream too, so A sees B's question.
    const reply: BackendChatMessage = backend.pushChatMessage(chat.id, 'assistant', 'reply', 'the answer');
    await until(() => a.chatTexts(chat.id).length === 2 && b.chatTexts(chat.id).length === 2);
    expect(a.chatTexts(chat.id)).toEqual(['from B', reply.content]);
    expect(b.chatTexts(chat.id)).toEqual(['from B', reply.content]);
  });

  test('closing a chat on one device does not close it on the other', async () => {
    const meeting = await a.meetings.start({ source: 'live', title: 'standup' });
    const chat = backend.addChat(meeting.id, 'shared');
    a.chats.follow(meeting.id, chat.id);
    b.chats.follow(meeting.id, chat.id);
    await until(() => backend.chatSockets.size === 2);

    b.chats.unfollow(chat.id);
    await until(() => backend.chatSockets.size === 1);
    backend.pushChatMessage(chat.id, 'assistant', 'reply', 'still here');
    await until(() => a.chatTexts(chat.id).length === 1);
    expect(b.chatTexts(chat.id)).toEqual([]);
  });

  test('signing B out stops B\'s streams and leaves A running', async () => {
    const meeting = await a.meetings.start({ source: 'live', title: 'standup' });
    const chat = backend.addChat(meeting.id, 'shared');
    await b.meetings.subscribe(meeting.id);
    b.chats.follow(meeting.id, chat.id);
    await until(() => backend.streams.size === 2 && backend.chatSockets.size === 1);

    // What main.ts does when B's session ends.
    b.meetings.unsubscribe();
    b.chats.unfollowAll();
    await until(() => backend.streams.size === 1 && backend.chatSockets.size === 0);

    backend.push(meeting.id, 'A still hears this');
    await until(() => a.texts.length === 1);
    expect(b.texts).toEqual([]);
    expect(backend.meetings.get(meeting.id)?.status).toBe('live');
  });
});
