import { parseArgs } from "node:util";
import { createDb } from "../src/db/client";
import { env } from "../src/env";
import { MeetingRepository } from "../src/db/repositories/meeting.repository";
import { SegmentRepository } from "../src/db/repositories/segment.repository";
import { LIVE_RETRY, SegmentAppender } from "../src/log/append";
import { ReplaySource } from "../src/producer/replay";
import { planResume, type LastSegment } from "../src/producer/resume";
import { appendFromSource } from "../src/producer/run";
import type { TranscriptSource } from "../src/producer/source";

const DEFAULT_FIXTURE = "fixtures/7ARBJQn6QkM.json";
const DEFAULT_MAX_SECONDS = 300;

const USAGE = `usage:
  bun run producer youtube [url] [--max-seconds 300] [--no-realtime]
  bun run producer replay [fixture.json] [--count N] [--interval 500]

youtube transcribes the audio of a video through Deepgram (default: YOUTUBE_URL).
replay re-emits a recorded transcript fixture (default: ${DEFAULT_FIXTURE}).

options:
  --meeting <id>   append to an existing meeting (default: create a new one)
  --title <text>   title for a new meeting
  --end            mark the meeting ended when the producer finishes`;

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    meeting: { type: "string" },
    title: { type: "string" },
    count: { type: "string" },
    interval: { type: "string", default: "500" },
    "max-seconds": { type: "string" },
    "no-realtime": { type: "boolean", default: false },
    end: { type: "boolean", default: false },
  },
});

const [mode, argument] = positionals;
if (mode !== "youtube" && mode !== "replay") {
  console.error(USAGE);
  process.exit(2);
}
const target = argument ?? (mode === "youtube" ? env.YOUTUBE_URL : DEFAULT_FIXTURE);

if (mode === "youtube" && !env.DEEPGRAM_API_KEY) {
  console.error("DEEPGRAM_API_KEY is not set");
  process.exit(1);
}

const { db, sql, close } = createDb();
const meetings = new MeetingRepository(db);
const segments = new SegmentRepository(db);

const existing = values.meeting ? await meetings.findById(values.meeting) : null;
if (values.meeting && !existing) {
  console.error(`meeting ${values.meeting} not found`);
  await close();
  process.exit(1);
}
const meeting = existing ?? (await meetings.create(values.title ?? `${mode} ${target}`));

const appender = await SegmentAppender.open(
  {
    sql,
    segments,
    ...LIVE_RETRY,
    spoolDir: "spool",
    onSpoolError: (error) => console.error("SPOOL write failed, rows are only in memory:", error),
    onHeartbeat: (id) => meetings.touchHeartbeat(id),
    readMeetingStatus: async (id) => (await meetings.findById(id))?.status ?? null,
    onReattach: async (id) => {
      await meetings.setStatus(id, "live");
    },
    onHealth: ({ state, pending, error }) =>
      console.warn(
        state === "degraded"
          ? `DB unreachable, buffering ${pending} segment(s) and retrying: ${error instanceof Error ? error.message : error}`
          : `DB back, buffered segments are written (${pending} still pending)`,
      ),
  },
  meeting.id,
);
await meetings.setStatus(meeting.id, "live");
const head = await segments.head(meeting.id);
const lastRow = head > 0 ? await segments.findBySeq(meeting.id, head) : null;
const stored: LastSegment | null = lastRow
  ? { endMs: lastRow.endMs, at: lastRow.createdAt.getTime() }
  : null;
// rows recovered from the spool are newer than anything the database has
const last = appender.replayTail && (!stored || appender.replayTail.endMs > stored.endMs)
  ? appender.replayTail
  : stored;
const plan = planResume(last, Date.now(), { withGap: mode === "youtube" });
const baseMs = plan.baseMs;
if (plan.gap) {
  appender.appendGap(plan.gap.startMs, plan.gap.endMs).catch(() => undefined);
  console.log(`PRODUCER resumed after a break, recorded a gap ${plan.gap.startMs}-${plan.gap.endMs}ms`);
}

console.log(`PRODUCER pid=${process.pid} mode=${mode} meeting=${meeting.id} head=${head}`);
if (appender.replayed) console.log(`PRODUCER replayed ${appender.replayed} spooled segment(s) the database was missing`);

async function createSource(): Promise<TranscriptSource> {
  if (mode === "replay") {
    return new ReplaySource({
      file: target,
      count: values.count ? Number(values.count) : undefined,
      intervalMs: Number(values.interval),
      startOffsetMs: baseMs,
    });
  }
  const { YoutubeDeepgramSource } = await import("../src/producer/youtube");
  return new YoutubeDeepgramSource({
    url: target,
    deepgram: { apiKey: env.DEEPGRAM_API_KEY!, onWarn: (m) => console.warn(`DEEPGRAM ${m}`) },
    baseMs,
    maxSeconds: Number(values["max-seconds"] ?? DEFAULT_MAX_SECONDS),
    realtime: !values["no-realtime"],
  });
}

const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());

let appended = 0;
let exitCode = 0;
try {
  const source = await createSource();
  appended = await appendFromSource(source, appender, abort.signal, {
    whenFull: "drop",
    onAppend: (row) =>
      console.log(`APPEND seq=${row.seq} speaker=${row.speakerKey ?? "-"} text=${JSON.stringify(row.text)}`),
    onDrop: ({ count, startMs, endMs }) =>
      console.warn(`BACKLOG FULL dropped ${count} segment(s) ${startMs}-${endMs}ms, recorded as a gap`),
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  await appender.close();
  if (values.end || !existing || exitCode !== 0) await meetings.setStatus(meeting.id, "ended");
  console.log(`PRODUCER done pid=${process.pid} appended=${appended} head=${await segments.head(meeting.id)}`);
  await close();
}
process.exit(exitCode);
