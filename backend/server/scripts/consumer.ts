import { parseArgs } from "node:util";
import { createDb } from "../src/db/client";
import { CursorRepository } from "../src/db/repositories/cursor.repository";
import {
  ChatRepository,
  MeetingRepository,
} from "../src/db/repositories/meeting.repository";
import { SegmentRepository } from "../src/db/repositories/segment.repository";
import { TranscriptConsumer } from "../src/log/consumer";
import { CursorService } from "../src/log/cursor";
import { dedupeHandler } from "../src/log/dedupe";
import { PgWakeBridge, WakeHub } from "../src/log/wake";

const USAGE = `usage: bun run consumer [options]

options:
  --meeting <id>      meeting to read (default: the latest meeting)
  --name <name>       consumer identity; the same name resumes its cursor (default: consumer)
  --fresh             use a one-off identity (name-<pid>) so the cursor starts from the beginning
  --tail <n>          for a brand-new consumer, start n segments behind the head
  --idle-exit <ms>    exit after this long without a new segment (default: run until Ctrl+C)`;

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    meeting: { type: "string" },
    name: { type: "string", default: "consumer" },
    fresh: { type: "boolean", default: false },
    tail: { type: "string" },
    "idle-exit": { type: "string" },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const { db, sql, close } = createDb();
const meetings = new MeetingRepository(db);
const chats = new ChatRepository(db);
const segments = new SegmentRepository(db);
const cursorRepo = new CursorRepository(db);
const cursors = new CursorService({ chats, cursors: cursorRepo, segments });

const meeting = values.meeting
  ? await meetings.findById(values.meeting)
  : await meetings.latest();
if (!meeting) {
  console.error(values.meeting ? `meeting ${values.meeting} not found` : "no meetings yet; start a producer first");
  await close();
  process.exit(1);
}

const identity = values.fresh ? `${values.name}-${process.pid}` : values.name!;
const chat =
  (await chats.findByTitle(meeting.id, identity)) ?? (await chats.create(meeting.id, identity));

const startCursor = await cursors.attach(
  meeting.id,
  chat.id,
  values.tail ? { kind: "tail", tail: Number(values.tail) } : { kind: "beginning" },
);
const head = await segments.head(meeting.id);

console.log(
  `CONSUMER pid=${process.pid} name=${identity} meeting=${meeting.id} start_cursor=${startCursor} head=${head}`,
);

const hub = new WakeHub();
const bridge = new PgWakeBridge(sql, hub);
await bridge.start();

const abort = new AbortController();
const stop = () => abort.abort();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const idleMs = values["idle-exit"] ? Number(values["idle-exit"]) : 0;
let idleTimer: Timer | undefined;
const armIdle = () => {
  if (!idleMs) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(stop, idleMs);
};
armIdle();

let received = 0;
const handler = dedupeHandler(async ({ segments: batch }) => {
  for (const segment of batch) {
    received++;
    console.log(
      `SEG seq=${segment.seq} speaker=${segment.speakerKey ?? "-"} ms=${segment.startMs}-${segment.endMs} text=${JSON.stringify(segment.text)}`,
    );
  }
  armIdle();
}, startCursor);

const consumer = new TranscriptConsumer({
  hub,
  readAfter: (m, after, limit) => segments.readAfter(m, after, limit),
  sql,
  cursors,
});

let exitCode = 0;
try {
  await consumer.run({
    meetingId: meeting.id,
    chatId: chat.id,
    handler,
    signal: abort.signal,
    onOutage: (error, attempt) =>
      console.error(
        `CONSUMER DB unreachable, retrying (attempt ${attempt}): ${error instanceof Error ? error.message : error}`,
      ),
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  clearTimeout(idleTimer);
  const committed = await cursors.position(meeting.id, chat.id).catch(() => startCursor);
  console.log(`CONSUMER done pid=${process.pid} name=${identity} committed=${committed} received=${received}`);
  await bridge.stop();
  await close();
}
process.exit(exitCode);
