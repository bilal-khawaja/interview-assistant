import { beforeEach, describe, expect, test } from 'bun:test';
import type {
  BackendChat,
  BackendChatKind,
  BackendChatMessage,
  BackendChatRole,
  ChatMessageEvent,
  ChatResetEvent,
  ChatStatusEvent,
  SendChatMessageInput,
} from '../types/meeting-chat';
import type { ApiResult } from '../types/transcript';
import { MeetingChatStore, type MeetingChatApi } from './meeting-chat-store';

const message = (
  seq: number,
  role: BackendChatRole,
  kind: BackendChatKind,
  content = `m${seq}`,
  id = `id${seq}`,
): BackendChatMessage => ({ id, seq, role, kind, content, transcriptSeq: null, createdAt: '2026-01-01T00:00:00Z' });

class FakeApi implements MeetingChatApi {
  handlers!: Parameters<MeetingChatApi['listen']>[0];
  listens = 0;
  chats: BackendChat[] = [];
  createResult: ApiResult<{ chat: BackendChat }> = {
    chat: { id: 'c1', meetingId: 'm1', title: '', createdAt: '2026-01-01T00:00:00Z' },
  };
  sendResult: ApiResult<{ created: boolean }> = { created: true };
  sent: SendChatMessageInput[] = [];
  followed: string[] = [];
  unfollowed: string[] = [];
  sendGate: Promise<void> | null = null;

  async list(): Promise<ApiResult<{ chats: BackendChat[] }>> {
    return { chats: this.chats };
  }
  async create() {
    return this.createResult;
  }
  async send(input: SendChatMessageInput) {
    this.sent.push(input);
    if (this.sendGate) await this.sendGate;
    return this.sendResult;
  }
  async follow(_meetingId: string, chatId: string) {
    this.followed.push(chatId);
    return { ok: true };
  }
  async unfollow(chatId: string) {
    this.unfollowed.push(chatId);
    return { ok: true };
  }
  listen(handlers: Parameters<MeetingChatApi['listen']>[0]) {
    this.listens++;
    this.handlers = handlers;
    return () => undefined;
  }

  deliver(chatId: string, msg: BackendChatMessage): void {
    this.handlers.onMessage({ chatId, message: msg } satisfies ChatMessageEvent);
  }
  status(chatId: string, status: ChatStatusEvent['status'], detail?: string): void {
    this.handlers.onStatus({ chatId, status, detail });
  }
  reset(chatId: string): void {
    this.handlers.onReset({ chatId } satisfies ChatResetEvent);
  }
}

let api: FakeApi;
let store: MeetingChatStore;
let counter: number;

beforeEach(() => {
  api = new FakeApi();
  counter = 0;
  store = new MeetingChatStore(api, () => `out${++counter}`);
});

const chat = (id = 'c1') => store.getState().chats[id]!;
const texts = (id = 'c1') => chat(id).messages.map((m) => m.content);

describe('MeetingChatStore', () => {
  test('opening a chat follows it and shows an empty, not-pending chat', async () => {
    await store.open('m1', 'c1');
    expect(api.followed).toEqual(['c1']);
    expect(chat()).toMatchObject({ chatId: 'c1', meetingId: 'm1', messages: [], pending: false, status: null, error: null });
  });

  test('the main process is listened to once, however many chats open', async () => {
    await store.open('m1', 'c1');
    await store.open('m1', 'c2');
    expect(api.listens).toBe(1);
  });

  test('creating a chat opens it', async () => {
    const result = await store.createChat('m1', 'tab');
    expect(result.error).toBeUndefined();
    expect(api.followed).toEqual(['c1']);
    expect(store.getState().chats.c1).toBeDefined();
  });

  test('a failed create opens nothing and returns the error', async () => {
    api.createResult = { error: 'cannot reach the backend' };
    const result = await store.createChat('m1');
    expect(result.error).toBe('cannot reach the backend');
    expect(api.followed).toEqual([]);
    expect(store.getState().chats).toEqual({});
  });

  test('history then live messages are shown in seq order', async () => {
    await store.open('m1', 'c1');
    api.deliver('c1', message(1, 'user', 'followup', 'hi'));
    api.deliver('c1', message(2, 'assistant', 'reply', 'hello'));
    expect(texts()).toEqual(['hi', 'hello']);
    expect(chat().messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(chat().pending).toBe(false);
  });

  test('suggestions and summaries never reach the screen', async () => {
    await store.open('m1', 'c1');
    api.deliver('c1', message(1, 'assistant', 'suggestion', 'Postgres'));
    api.deliver('c1', message(2, 'user', 'followup', 'question'));
    api.deliver('c1', message(3, 'assistant', 'suggestion', 'Kafka'));
    api.deliver('c1', message(4, 'summary', 'summary', 'earlier chat'));
    api.deliver('c1', message(5, 'assistant', 'reply', 'answer'));
    expect(texts()).toEqual(['question', 'answer']);
  });

  test('a suggestion arriving after the question does not stop the chat from waiting for the answer', async () => {
    await store.open('m1', 'c1');
    api.deliver('c1', message(1, 'user', 'followup', 'question'));
    api.deliver('c1', message(2, 'assistant', 'suggestion', 'unrelated'));
    expect(chat().pending).toBe(true);
    api.deliver('c1', message(3, 'assistant', 'reply', 'answer'));
    expect(chat().pending).toBe(false);
  });

  test('notices are shown as system lines and end the wait', async () => {
    await store.open('m1', 'c1');
    api.deliver('c1', message(1, 'user', 'followup', 'question'));
    expect(chat().pending).toBe(true);
    api.deliver('c1', message(2, 'system', 'notice', 'budget used up'));
    expect(chat().messages.at(-1)).toMatchObject({ role: 'system', kind: 'notice', content: 'budget used up' });
    expect(chat().pending).toBe(false);
  });

  test('a message the main process repeats is shown once', async () => {
    await store.open('m1', 'c1');
    api.deliver('c1', message(1, 'user', 'followup', 'hi'));
    api.deliver('c1', message(1, 'user', 'followup', 'hi'));
    api.deliver('c1', message(2, 'assistant', 'reply', 'yo'));
    expect(texts()).toEqual(['hi', 'yo']);
  });

  test('following again replays the history without duplicating it', async () => {
    await store.open('m1', 'c1');
    api.deliver('c1', message(1, 'user', 'followup', 'hi'));
    api.deliver('c1', message(2, 'assistant', 'reply', 'yo'));
    await store.open('m1', 'c1');
    api.deliver('c1', message(1, 'user', 'followup', 'hi'));
    api.deliver('c1', message(2, 'assistant', 'reply', 'yo'));
    api.deliver('c1', message(3, 'user', 'followup', 'more'));
    expect(texts()).toEqual(['hi', 'yo', 'more']);
    expect(api.followed).toEqual(['c1', 'c1']);
  });

  test('events for a chat that is not open are ignored', () => {
    store.init();
    api.deliver('ghost', message(1, 'user', 'followup'));
    expect(store.getState().chats).toEqual({});
  });

  test('connection status and detail follow the stream', async () => {
    await store.open('m1', 'c1');
    api.status('c1', 'live');
    expect(chat()).toMatchObject({ status: 'live', detail: null });
    api.status('c1', 'degraded', 'database unreachable');
    expect(chat()).toMatchObject({ status: 'degraded', detail: 'database unreachable' });
  });

  describe('sending', () => {
    test('the message shows at once as sending, then the backend sees it with its id and mode', async () => {
      await store.open('m1', 'c1');
      let release!: () => void;
      api.sendGate = new Promise((resolve) => (release = resolve));
      const sending = store.send('c1', '  what was said?  ', 'steer');
      expect(chat().messages).toHaveLength(1);
      expect(chat().messages[0]).toMatchObject({
        id: 'out1',
        seq: null,
        role: 'user',
        kind: 'steer',
        content: 'what was said?',
        delivery: 'sending',
      });
      expect(chat().pending).toBe(true);
      release();
      await sending;
      expect(api.sent).toEqual([{ meetingId: 'm1', chatId: 'c1', messageId: 'out1', text: 'what was said?', mode: 'steer' }]);
      expect(chat().messages[0]?.delivery).toBe('sent');
    });

    test('the default mode is followup', async () => {
      await store.open('m1', 'c1');
      await store.send('c1', 'hi');
      expect(api.sent[0]?.mode).toBe('followup');
    });

    test('blank text is not sent and a chat that is not open is ignored', async () => {
      await store.open('m1', 'c1');
      await store.send('c1', '   ');
      await store.send('ghost', 'hi');
      expect(api.sent).toEqual([]);
      expect(chat().messages).toEqual([]);
    });

    test('the echo replaces the optimistic message instead of adding a second one', async () => {
      await store.open('m1', 'c1');
      await store.send('c1', 'hi');
      api.deliver('c1', message(1, 'user', 'followup', 'hi', 'out1'));
      expect(chat().messages).toHaveLength(1);
      expect(chat().messages[0]).toMatchObject({ id: 'out1', seq: 1, delivery: 'sent' });
      api.deliver('c1', message(2, 'assistant', 'reply', 'yo'));
      expect(texts()).toEqual(['hi', 'yo']);
      expect(chat().pending).toBe(false);
    });

    test('the echo can arrive before the send call returns', async () => {
      await store.open('m1', 'c1');
      let release!: () => void;
      api.sendGate = new Promise((resolve) => (release = resolve));
      const sending = store.send('c1', 'hi');
      api.deliver('c1', message(1, 'user', 'followup', 'hi', 'out1'));
      release();
      await sending;
      expect(chat().messages).toHaveLength(1);
      expect(chat().messages[0]).toMatchObject({ seq: 1, delivery: 'sent' });
    });

    test('messages still on their way stay after the stored ones, in send order', async () => {
      await store.open('m1', 'c1');
      let release!: () => void;
      api.sendGate = new Promise((resolve) => (release = resolve));
      const first = store.send('c1', 'first');
      const second = store.send('c1', 'second');
      api.deliver('c1', message(1, 'assistant', 'reply', 'earlier answer'));
      expect(texts()).toEqual(['earlier answer', 'first', 'second']);
      api.deliver('c1', message(2, 'user', 'followup', 'first', 'out1'));
      expect(texts()).toEqual(['earlier answer', 'first', 'second']);
      expect(chat().messages.map((m) => m.seq)).toEqual([1, 2, null]);
      release();
      await Promise.all([first, second]);
    });

    test('a failed send keeps the message, marks it failed and reports why', async () => {
      await store.open('m1', 'c1');
      api.sendResult = { error: 'cannot reach the backend', status: undefined };
      await store.send('c1', 'hi');
      expect(chat().messages[0]).toMatchObject({ delivery: 'failed', content: 'hi' });
      expect(chat().error).toBe('cannot reach the backend');
      expect(chat().pending).toBe(false);
    });

    test('retrying reuses the same message id, so the backend cannot create it twice', async () => {
      await store.open('m1', 'c1');
      api.sendResult = { error: 'cannot reach the backend' };
      await store.send('c1', 'hi');
      api.sendResult = { created: true };
      await store.retry('c1', 'out1');
      expect(api.sent.map((s) => s.messageId)).toEqual(['out1', 'out1']);
      expect(chat().messages).toHaveLength(1);
      expect(chat().messages[0]?.delivery).toBe('sent');
      expect(chat().error).toBeNull();
      expect(chat().pending).toBe(true);
    });

    test('only a failed message can be retried', async () => {
      await store.open('m1', 'c1');
      await store.send('c1', 'hi');
      await store.retry('c1', 'out1');
      await store.retry('c1', 'nope');
      expect(api.sent).toHaveLength(1);
    });

    test('the next send clears the previous error', async () => {
      await store.open('m1', 'c1');
      api.sendResult = { error: 'down' };
      await store.send('c1', 'one');
      api.sendResult = { created: true };
      await store.send('c1', 'two');
      expect(chat().error).toBeNull();
    });

    test('a steer that stopped an answer leaves the earlier question unanswered but the chat not waiting', async () => {
      await store.open('m1', 'c1');
      api.deliver('c1', message(1, 'user', 'followup', 'slow question'));
      api.deliver('c1', message(2, 'user', 'steer', 'change course'));
      expect(chat().pending).toBe(true);
      api.deliver('c1', message(3, 'assistant', 'reply', 'ok'));
      expect(chat().pending).toBe(false);
      expect(texts()).toEqual(['slow question', 'change course', 'ok']);
    });
  });

  describe('reset and close', () => {
    test('a reset drops stored messages but keeps what the user is still sending', async () => {
      await store.open('m1', 'c1');
      api.deliver('c1', message(1, 'user', 'followup', 'old'));
      api.sendResult = { error: 'down' };
      await store.send('c1', 'unsent');
      api.reset('c1');
      expect(texts()).toEqual(['unsent']);
      api.deliver('c1', message(1, 'user', 'followup', 'fresh'));
      expect(texts()).toEqual(['fresh', 'unsent']);
    });

    test('closing forgets the chat and stops following it', async () => {
      await store.open('m1', 'c1');
      api.deliver('c1', message(1, 'user', 'followup', 'hi'));
      await store.close('c1');
      expect(api.unfollowed).toEqual(['c1']);
      expect(store.getState().chats).toEqual({});
      api.deliver('c1', message(2, 'assistant', 'reply', 'late'));
      expect(store.getState().chats).toEqual({});
    });

    test('closing one chat leaves the others alone', async () => {
      await store.open('m1', 'c1');
      await store.open('m1', 'c2');
      api.deliver('c2', message(1, 'user', 'followup', 'kept'));
      await store.close('c1');
      expect(texts('c2')).toEqual(['kept']);
    });

    test('a reopened chat starts clean and takes the replayed history', async () => {
      await store.open('m1', 'c1');
      api.deliver('c1', message(1, 'user', 'followup', 'hi'));
      await store.close('c1');
      await store.open('m1', 'c1');
      expect(chat().messages).toEqual([]);
      api.deliver('c1', message(1, 'user', 'followup', 'hi'));
      expect(texts()).toEqual(['hi']);
    });
  });

  test('subscribers are told on every change and can stop listening', async () => {
    let calls = 0;
    const stop = store.subscribe(() => calls++);
    await store.open('m1', 'c1');
    api.deliver('c1', message(1, 'user', 'followup', 'hi'));
    expect(calls).toBe(2);
    stop();
    api.deliver('c1', message(2, 'assistant', 'reply', 'yo'));
    expect(calls).toBe(2);
  });

  test('a chat whose state did not change keeps the same object, so views do not re-render', async () => {
    await store.open('m1', 'c1');
    await store.open('m1', 'c2');
    const before = chat('c2');
    api.deliver('c1', message(1, 'user', 'followup', 'hi'));
    expect(chat('c2')).toBe(before);
  });
});
