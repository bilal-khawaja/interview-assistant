// Run as a subprocess by the spool tests: accepts rows while the database "is down",
// reports READY once they are spooled, then waits to be killed.
import { createDb } from "../db/client";
import { SegmentRepository } from "../db/repositories/segment.repository";
import { SegmentAppender } from "./append";

const [meetingId, spoolDir] = Bun.argv.slice(2);
if (!meetingId || !spoolDir) throw new Error("usage: spool-crash.fixture.ts <meetingId> <spoolDir>");

const { db, sql } = createDb();
const real = new SegmentRepository(db);
const unreachable = {
  head: (id: string) => real.head(id),
  findBySeq: async () => null,
  appendIgnore: async () => {
    throw Object.assign(new Error("Failed to connect"), { code: "ERR_POSTGRES_CONNECTION_REFUSED" });
  },
} as unknown as SegmentRepository;

const appender = await SegmentAppender.open(
  { sql, segments: unreachable, spoolDir, retryBaseMs: 5, retryMaxMs: 20, lockCheckMs: 0, probeBeforeWrite: false },
  meetingId,
);
for (let i = 1; i <= 4; i++) {
  appender
    .append({ text: `crash ${i}`, startMs: i * 1000, endMs: i * 1000 + 900, speakerKey: i % 2 ? "spk_0" : "spk_1" })
    .catch(() => undefined);
}
console.log("READY");
setInterval(() => undefined, 1000);
