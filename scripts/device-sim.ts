/**
 * Two devices, one account, one backend: a headless way to try what a second computer would do.
 *
 *   bun run scripts/device-sim.ts                    starts its own backend and a fake Deepgram
 *   bun run scripts/device-sim.ts --backend URL      uses a backend that is already running
 *
 * Each "device" is what the Electron main process is: its own BackendApi (and session token),
 * MeetingService and MeetingChatService, the same classes the app runs. Device A starts a live
 * meeting and talks into it; device B signs in separately, opens the meeting and a chat on it.
 * The script checks both see the same transcript, only A sends audio, B's chat message reaches
 * A's chat stream, and a different account sees none of it. Exits 1 if any check fails.
 *
 * With its own backend the model key is set to an invalid one, so no model is ever called and
 * nothing is spent: the chat message is delivered and the model call just fails.
 */
import path from 'node:path';
import { parseArgs } from 'node:util';
import { BackendApi } from '../src/transcript/services/backend-api.client';
import { MeetingChatService, type MeetingChatEvent } from '../src/transcript/services/meeting-chat.service';
import { MeetingService, type TranscriptEvent } from '../src/transcript/services/meeting.service';
import { BackendProcess } from '../src/transcript/matrix/backend-process';
import { FakeDeepgram } from '../src/transcript/matrix/fake-deepgram';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { backend: { type: 'string' }, keep: { type: 'boolean', default: false } },
});

const BACKEND_DIR = path.resolve(import.meta.dir, '../backend/server');
const PASSWORD = 'device-sim password 1';
// Random as well as timed, so runs started in the same millisecond still get different accounts.
const tag = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`;
const emails = { owner: `devsim-${tag}@example.com`, stranger: `devsim-${tag}-other@example.com` };

const results: { ok: boolean; name: string; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ ok, name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}

async function until(condition: () => boolean | Promise<boolean>, what: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}`);
}

/** One computer: its own session and services, like one running copy of the app. */
class Device {
  readonly api: BackendApi;
  readonly meetings: MeetingService;
  readonly chats: MeetingChatService;
  readonly transcript: TranscriptEvent[] = [];
  readonly chatEvents: MeetingChatEvent[] = [];
  private mic: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly name: string,
    url: string,
  ) {
    this.api = new BackendApi(url);
    const reconnect = { reconnect: { baseMs: 100, maxMs: 500 } };
    this.meetings = new MeetingService(this.api, {
      pollMs: 300,
      drainMs: 800,
      drainMaxMs: 8_000,
      streamOptions: reconnect,
      uplinkOptions: reconnect,
    });
    this.chats = new MeetingChatService(this.api, { streamOptions: reconnect });
    this.meetings.onEvent((event) => this.transcript.push(event));
    this.chats.onEvent((event) => this.chatEvents.push(event));
  }

  get seqs(): number[] {
    return this.transcript.flatMap((e) => (e.type === 'segment' ? [e.event.segment.seq] : []));
  }

  get lastStatus(): string | undefined {
    return this.transcript.filter((e) => e.type === 'status').at(-1)?.event.status;
  }

  chatContents(chatId: string): string[] {
    return this.chatEvents.flatMap((e) => (e.type === 'message' && e.event.chatId === chatId ? [e.event.message.content] : []));
  }

  /** What a microphone does: 100 ms of 16 kHz mono PCM every 100 ms. */
  talk(): void {
    this.mic = setInterval(() => this.meetings.sendAudio(new Uint8Array(3200).fill(1)), 100);
  }

  hush(): void {
    if (this.mic) clearInterval(this.mic);
    this.mic = null;
  }

  dispose(): void {
    this.hush();
    this.meetings.dispose();
    this.chats.dispose();
  }
}

async function signUp(url: string, email: string, name: string): Promise<string> {
  return (await new BackendApi(url).signUp({ name, email, password: PASSWORD })).token;
}

async function signIn(url: string, email: string): Promise<string> {
  return (await new BackendApi(url).signIn({ email, password: PASSWORD })).token;
}

let backend: BackendProcess | null = null;
let deepgram: FakeDeepgram | null = null;
const devices: Device[] = [];

async function main(): Promise<void> {
  let url = values.backend?.replace(/\/+$/, '');
  if (!url) {
    deepgram = new FakeDeepgram();
    await deepgram.start();
    backend = new BackendProcess(BACKEND_DIR, {
      DEEPGRAM_API_KEY: 'device-sim',
      DEEPGRAM_WS_URL: deepgram.url,
      OPENAI_API_KEY: 'sk-device-sim-not-a-real-key',
    });
    await backend.start();
    url = backend.url;
  }
  console.log(`backend ${url}${backend ? ' (started by this script)' : ''}`);

  // One account, two separate sign-ins: two devices, two sessions.
  const tokenA = await signUp(url, emails.owner, 'Device Sim');
  const tokenB = await signIn(url, emails.owner);
  check('the two devices have different sessions', tokenA !== tokenB);

  const a = new Device('A', url);
  const b = new Device('B', url);
  devices.push(a, b);
  a.api.setToken(tokenA);
  b.api.setToken(tokenB);

  // A starts a meeting and talks.
  const meeting = await a.meetings.start({ source: 'live', title: 'device sim' });
  a.talk();
  await until(() => a.seqs.length >= 3, 'three segments on A');
  check('A started a live meeting and hears itself', a.seqs.length >= 3, `${a.seqs.length} segments`);

  // B opens it from its own list.
  const listed = await b.meetings.list();
  check('B sees the meeting in its own list', listed.some((m) => m.id === meeting.id));
  await b.meetings.subscribe(meeting.id);
  await until(() => b.seqs.length >= a.seqs.length, 'B to catch up with A');
  check('B follows the transcript from the first line', b.seqs[0] === 1 && b.seqs.every((seq, i) => seq === i + 1));
  check('B does not own the meeting and sends no audio', !b.meetings.activeIsOwned && !b.meetings.sendAudio(new Uint8Array(3200)));
  if (deepgram) check('only one transcription connection exists', deepgram.connections === 1, `${deepgram.connections}`);

  // Both see the same chats, all on this meeting.
  const chatsA = await a.chats.list(meeting.id);
  const chatsB = await b.chats.list(meeting.id);
  check('both devices list the same chats', JSON.stringify(chatsA.map((c) => c.id)) === JSON.stringify(chatsB.map((c) => c.id)) && chatsA.length >= 1);
  check('every chat belongs to this meeting', [...chatsA, ...chatsB].every((c) => c.meetingId === meeting.id));

  // B talks to a chat; A, following the same chat, receives it.
  const chat = chatsA[0]!;
  a.chats.follow(meeting.id, chat.id);
  b.chats.follow(meeting.id, chat.id);
  await until(() => a.chatEvents.some((e) => e.type === 'status' && e.event.status === 'live') && b.chatEvents.some((e) => e.type === 'status' && e.event.status === 'live'), 'both chat streams live');
  const question = `hello from B ${tag}`;
  await b.chats.send({ meetingId: meeting.id, chatId: chat.id, messageId: crypto.randomUUID(), text: question, mode: 'followup' });
  await until(() => a.chatContents(chat.id).includes(question), "B's message on A's chat stream");
  check("B's chat message reached A's chat stream", a.chatContents(chat.id).includes(question));
  // B's own copy arrives on its own socket, a moment apart from A's.
  await until(() => b.chatContents(chat.id).includes(question), "B's own chat stream to carry its message", 10_000);
  check("B's own stream carried it too", b.chatContents(chat.id).includes(question));

  // A different account sees none of it.
  const stranger = new Device('stranger', url);
  devices.push(stranger);
  stranger.api.setToken(await signUp(url, emails.stranger, 'Someone Else'));
  check("another account's list is empty", (await stranger.meetings.list()).length === 0);
  const peek = await stranger.meetings.subscribe(meeting.id).then(
    () => 'allowed',
    (error: { status?: number }) => `status ${error.status}`,
  );
  check("another account cannot open the meeting", peek === 'status 404', peek);
  const peekChats = await stranger.chats.list(meeting.id).then(
    () => 'allowed',
    (error: { status?: number }) => `status ${error.status}`,
  );
  check("another account cannot list its chats", peekChats === 'status 404', peekChats);

  // A ends it; B notices; both hold exactly what the server holds.
  a.hush();
  await a.meetings.end(meeting.id);
  await until(() => a.lastStatus === 'ended' && b.lastStatus === 'ended', 'both devices to see the end');
  check('B noticed the meeting end', b.lastStatus === 'ended');
  check('both devices hold the same transcript, in order, with nothing repeated', JSON.stringify(a.seqs) === JSON.stringify(b.seqs) && a.seqs.every((seq, i) => seq === i + 1), `${a.seqs.length} segments each`);
}

async function cleanup(): Promise<void> {
  for (const device of devices) device.dispose();
  await backend?.stop();
  await deepgram?.stop();
  if (values.keep || values.backend) return;
  // The accounts live in the backend's own database; remove the ones this run made.
  const script = `
    import { createDb } from './src/db/client';
    import { env } from './src/env';
    import { user } from './src/db/schema';
    import { like } from 'drizzle-orm';
    const client = createDb(env.DATABASE_URL);
    await client.db.delete(user).where(like(user.email, 'devsim-${tag}%'));
    await client.close();
  `;
  // Without the repo root's DATABASE_URL, so the backend's own .env decides which database this is.
  const { DATABASE_URL: _root, ...env } = process.env;
  const proc = Bun.spawn([process.execPath, '-e', script], { cwd: BACKEND_DIR, env, stdout: 'inherit', stderr: 'inherit' });
  if ((await proc.exited) !== 0) console.log('could not remove the devsim- accounts; delete them from the user table by hand');
}

let failed = false;
try {
  await main();
} catch (error) {
  failed = true;
  console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  if (backend) console.log(`--- backend output ---\n${backend.logs}`);
} finally {
  await cleanup();
}

const bad = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - bad} pass, ${bad} fail${failed ? ', and the run stopped early' : ''}`);
process.exit(bad > 0 || failed ? 1 : 0);
