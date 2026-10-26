import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { FakeBackend, until } from '../testing/fake-backend';
import { BackendApi, BackendApiError } from './backend-api.client';
import { MeetingChatService, type MeetingChatEvent } from './meeting-chat.service';

let backend: FakeBackend;
let service: MeetingChatService;
let events: MeetingChatEvent[];

beforeEach(() => {
  backend = new FakeBackend().start();
  service = new MeetingChatService(new BackendApi(backend.url), { streamOptions: { reconnect: { baseMs: 10, maxMs: 40 } } });
  events = [];
  service.onEvent((event) => events.push(event));
});
afterEach(async () => {
  service.dispose();
  await backend.stop();
});

const messageTexts = (chatId: string) =>
  events.flatMap((e) => (e.type === 'message' && e.event.chatId === chatId ? [e.event.message.content] : []));

describe('MeetingChatService', () => {
  test('creates chats, lists them oldest first, and a new chat has no messages yet', async () => {
    const meeting = backend.addMeeting();
    const a = await service.create(meeting.id, 'first');
    const b = await service.create(meeting.id);
    expect((await service.list(meeting.id)).map((c) => c.id)).toEqual([a.id, b.id]);
    expect(a).toMatchObject({ meetingId: meeting.id, title: 'first' });
    expect(b.title).toBe('');
  });

  test('a sent message is posted once, defaults to followup, and its reply arrives on the stream', async () => {
    const meeting = backend.addMeeting();
    const chat = await service.create(meeting.id);
    service.follow(meeting.id, chat.id);
    await until(() => backend.chatSockets.size === 1);

    const messageId = crypto.randomUUID();
    expect(await service.send({ meetingId: meeting.id, chatId: chat.id, messageId, text: 'what was said?' })).toEqual({
      created: true,
    });
    expect(backend.chatPosts).toEqual([{ chatId: chat.id, messageId, text: 'what was said?', mode: 'followup' }]);

    backend.pushChatMessage(chat.id, 'assistant', 'reply', 'Postgres was said');
    await until(() => messageTexts(chat.id).length === 2);
    expect(messageTexts(chat.id)).toEqual(['what was said?', 'Postgres was said']);
    const echoed = events.find((e) => e.type === 'message' && e.event.message.role === 'user');
    expect(echoed && echoed.type === 'message' && echoed.event.message.id).toBe(messageId);
  });

  test('sending the same messageId again reports it was not created', async () => {
    const meeting = backend.addMeeting();
    const chat = await service.create(meeting.id);
    const input = { meetingId: meeting.id, chatId: chat.id, messageId: crypto.randomUUID(), text: 'once' };
    expect((await service.send(input)).created).toBe(true);
    expect((await service.send(input)).created).toBe(false);
    expect(backend.chatMessages.get(chat.id)).toHaveLength(1);
  });

  test('a steer is sent as a steer', async () => {
    const meeting = backend.addMeeting();
    const chat = await service.create(meeting.id);
    await service.send({ meetingId: meeting.id, chatId: chat.id, messageId: crypto.randomUUID(), text: 'stop', mode: 'steer' });
    expect(backend.chatPosts[0]?.mode).toBe('steer');
  });

  test('several chats are followed at once and their events carry their own chat id', async () => {
    const meeting = backend.addMeeting();
    const a = await service.create(meeting.id);
    const b = await service.create(meeting.id);
    service.follow(meeting.id, a.id);
    service.follow(meeting.id, b.id);
    await until(() => backend.chatSockets.size === 2);
    backend.pushChatMessage(a.id, 'assistant', 'reply', 'for a');
    backend.pushChatMessage(b.id, 'assistant', 'reply', 'for b');
    await until(() => messageTexts(a.id).length === 1 && messageTexts(b.id).length === 1);
    expect(messageTexts(a.id)).toEqual(['for a']);
    expect(messageTexts(b.id)).toEqual(['for b']);
    const statuses = events.filter((e) => e.type === 'status' && e.event.status === 'live');
    expect(statuses.map((e) => e.type === 'status' && e.event.chatId).sort()).toEqual([a.id, b.id].sort());
  });

  test('following a chat again replays its history from the first message', async () => {
    const meeting = backend.addMeeting();
    const chat = await service.create(meeting.id);
    backend.pushChatMessage(chat.id, 'user', 'followup', 'one');
    backend.pushChatMessage(chat.id, 'assistant', 'reply', 'two');
    service.follow(meeting.id, chat.id);
    await until(() => messageTexts(chat.id).length === 2);
    service.follow(meeting.id, chat.id);
    await until(() => messageTexts(chat.id).length === 4);
    expect(backend.chatStreamOpens.map((o) => o.after)).toEqual([0, 0]);
    expect(backend.chatSockets.size).toBe(1);
  });

  test('unfollow stops delivery for that chat only', async () => {
    const meeting = backend.addMeeting();
    const a = await service.create(meeting.id);
    const b = await service.create(meeting.id);
    service.follow(meeting.id, a.id);
    service.follow(meeting.id, b.id);
    await until(() => backend.chatSockets.size === 2);
    service.unfollow(a.id);
    await until(() => backend.chatSockets.size === 1);
    backend.pushChatMessage(a.id, 'assistant', 'reply', 'ignored');
    backend.pushChatMessage(b.id, 'assistant', 'reply', 'seen');
    await until(() => messageTexts(b.id).length === 1);
    expect(messageTexts(a.id)).toEqual([]);
  });

  test('unfollowing a chat that is not followed is harmless', () => {
    expect(() => service.unfollow('nope')).not.toThrow();
  });

  test('backend errors reach the caller as BackendApiError with the status', async () => {
    const error = await service.list('00000000-0000-4000-8000-0000000000ff').catch((e) => e);
    expect(error).toBeInstanceOf(BackendApiError);
    expect((error as BackendApiError).status).toBe(404);
  });

  test('an unreachable backend is reported, not thrown past the caller', async () => {
    const meeting = backend.addMeeting();
    await backend.stop();
    const error = await service.list(meeting.id).catch((e) => e);
    expect(error).toBeInstanceOf(BackendApiError);
    expect((error as BackendApiError).status).toBeNull();
    backend = new FakeBackend().start(); // so afterEach can stop something
  });

  test('a listener that throws does not stop delivery to the others', async () => {
    const meeting = backend.addMeeting();
    const chat = await service.create(meeting.id);
    service.onEvent(() => {
      throw new Error('dead window');
    });
    const seen: string[] = [];
    service.onEvent((e) => e.type === 'message' && seen.push(e.event.message.content));
    service.follow(meeting.id, chat.id);
    await until(() => backend.chatSockets.size === 1);
    backend.pushChatMessage(chat.id, 'assistant', 'reply', 'still here');
    await until(() => seen.length === 1);
  });

  test('dispose closes every stream', async () => {
    const meeting = backend.addMeeting();
    const a = await service.create(meeting.id);
    service.follow(meeting.id, a.id);
    await until(() => backend.chatSockets.size === 1);
    service.dispose();
    await until(() => backend.chatSockets.size === 0);
  });
});
