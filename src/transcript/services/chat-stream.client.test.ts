import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { BackendChatMessage, ChatStreamStatus } from '../../types/meeting-chat';
import { FakeBackend, until } from '../testing/fake-backend';
import { ChatStreamClient } from './chat-stream.client';

let backend: FakeBackend;
let client: ChatStreamClient | null = null;

beforeEach(() => {
  backend = new FakeBackend().start();
});
afterEach(async () => {
  client?.stop();
  client = null;
  await backend.stop();
});

function follow(chatId: string, meetingId: string, extra: Partial<ConstructorParameters<typeof ChatStreamClient>[0]> = {}) {
  const messages: BackendChatMessage[] = [];
  const statuses: ChatStreamStatus[] = [];
  let resets = 0;
  client = new ChatStreamClient({
    baseUrl: backend.url,
    meetingId,
    chatId,
    onMessage: (m) => messages.push(m),
    onStatus: (s) => statuses.push(s),
    onReset: () => resets++,
    reconnect: { baseMs: 10, maxMs: 40 },
    ...extra,
  });
  client.start();
  return { messages, statuses, resets: () => resets };
}

function setup() {
  const meeting = backend.addMeeting();
  const chat = backend.addChat(meeting.id, 'tab');
  return { meeting, chat };
}

describe('ChatStreamClient', () => {
  test('delivers history then live messages in order and reports live', async () => {
    const { meeting, chat } = setup();
    backend.pushChatMessage(chat.id, 'user', 'followup', 'hi');
    backend.pushChatMessage(chat.id, 'assistant', 'reply', 'hello');
    const { messages, statuses } = follow(chat.id, meeting.id);
    await until(() => messages.length === 2);
    backend.pushChatMessage(chat.id, 'user', 'followup', 'more');
    await until(() => messages.length === 3);

    expect(messages.map((m) => m.content)).toEqual(['hi', 'hello', 'more']);
    expect(messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(messages[1]).toMatchObject({ role: 'assistant', kind: 'reply' });
    expect(statuses[0]).toBe('connecting');
    expect(statuses).toContain('live');
  });

  test('a dropped connection resumes after the last sequence number with nothing lost or repeated', async () => {
    const { meeting, chat } = setup();
    backend.pushChatMessage(chat.id, 'user', 'followup', 'a');
    backend.pushChatMessage(chat.id, 'assistant', 'reply', 'b');
    const { messages, statuses } = follow(chat.id, meeting.id);
    await until(() => messages.length === 2);

    backend.dropChatStreams(1006);
    backend.pushChatMessage(chat.id, 'user', 'followup', 'c'); // arrives while disconnected
    backend.pushChatMessage(chat.id, 'assistant', 'reply', 'd');
    await until(() => messages.length === 4);
    backend.pushChatMessage(chat.id, 'user', 'followup', 'e');
    await until(() => messages.length === 5);

    expect(messages.map((m) => m.content)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(statuses).toContain('reconnecting');
    expect(statuses.at(-1)).toBe('live');
    expect(backend.chatStreamOpens.map((o) => o.after)).toEqual([0, 2]);
  });

  test('a message the server repeats is delivered once', async () => {
    const { meeting, chat } = setup();
    const { messages } = follow(chat.id, meeting.id);
    await until(() => backend.chatSockets.size === 1);
    const first = backend.pushChatMessage(chat.id, 'user', 'followup', 'x');
    backend.broadcastChat({ type: 'message', ...first });
    backend.pushChatMessage(chat.id, 'assistant', 'reply', 'y');
    await until(() => messages.length === 2);
    expect(messages.map((m) => m.content)).toEqual(['x', 'y']);
  });

  test('suggestions and notices are delivered as they are, for the renderer to filter', async () => {
    const { meeting, chat } = setup();
    backend.pushChatMessage(chat.id, 'assistant', 'suggestion', 'Postgres', { transcriptSeq: 4 });
    backend.pushChatMessage(chat.id, 'system', 'notice', 'budget used up');
    const { messages } = follow(chat.id, meeting.id);
    await until(() => messages.length === 2);
    expect(messages.map((m) => `${m.kind}:${m.transcriptSeq}`)).toEqual(['suggestion:4', 'notice:null']);
  });

  test('a cursor ahead of the server restarts from zero and says so', async () => {
    const { meeting, chat } = setup();
    backend.pushChatMessage(chat.id, 'user', 'followup', 'one');
    const { messages, resets } = follow(chat.id, meeting.id, { after: 5 });
    await until(() => messages.length === 1);
    expect(resets()).toBe(1);
    expect(messages[0]?.content).toBe('one');
    expect(backend.chatStreamOpens.map((o) => o.after)).toEqual([5, 0]);
  });

  test('degraded and recovered frames show as status changes', async () => {
    const { meeting, chat } = setup();
    const { statuses } = follow(chat.id, meeting.id);
    await until(() => backend.chatSockets.size === 1);
    backend.broadcastChat({ type: 'degraded', reason: 'database unreachable' });
    await until(() => statuses.includes('degraded'));
    backend.broadcastChat({ type: 'recovered' });
    await until(() => statuses.at(-1) === 'live' && statuses.includes('degraded'));
  });

  test('silence longer than a few heartbeats is a dead connection and is retried', async () => {
    const { meeting, chat } = setup();
    backend.heartbeatMs = 30;
    const { statuses } = follow(chat.id, meeting.id);
    await until(() => backend.chatStreamOpens.length >= 2, 2_000);
    expect(statuses).toContain('reconnecting');
  });

  test('a refused stream keeps retrying and never throws', async () => {
    const { meeting, chat } = setup();
    backend.refuseStreams = true;
    const { statuses } = follow(chat.id, meeting.id);
    await until(() => statuses.includes('reconnecting'));
    backend.refuseStreams = false;
    await until(() => statuses.at(-1) === 'live');
  });

  test('stop closes the socket and nothing more is delivered', async () => {
    const { meeting, chat } = setup();
    const { messages } = follow(chat.id, meeting.id);
    await until(() => backend.chatSockets.size === 1);
    client?.stop();
    await until(() => backend.chatSockets.size === 0);
    backend.pushChatMessage(chat.id, 'user', 'followup', 'late');
    await new Promise((r) => setTimeout(r, 60));
    expect(messages).toEqual([]);
  });
});
