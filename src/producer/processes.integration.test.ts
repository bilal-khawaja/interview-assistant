import { afterAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { env } from "../env";
import { createDb, type DbClient } from "../db/client";
import { meetings, transcriptSegments } from "../db/schema";

const url = env.DATABASE_URL;

async function probe(): Promise<DbClient | null> {
  if (!url) return null;
  try {
    const client = createDb(url);
    await client.db.select().from(transcriptSegments).limit(0);
    return client;
  } catch {
    return null;
  }
}

const client = await probe();
await client?.close();
const run = client ? describe : describe.skip;

type Finished = { stdout: string; code: number; pid: number };

function start(script: string, args: string[]) {
  const child = Bun.spawn([process.execPath, `scripts/${script}.ts`, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const done = (async (): Promise<Finished> => {
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    const code = await child.exited;
    if (code !== 0) throw new Error(`${script} exited ${code}: ${stderr}`);
    return { stdout, code, pid: child.pid };
  })();
  return { child, done };
}

const meetingOf = (stdout: string) => {
  const id = field(stdout, "meeting")!;
  created.push(id);
  return id;
};
const seqs = (stdout: string) =>
  [...stdout.matchAll(/^SEG seq=(\d+)/gm)].map((m) => Number(m[1]));
const created: string[] = [];
const field = (stdout: string, name: string) =>
  stdout.match(new RegExp(`${name}=(\\S+)`))?.[1];

run("producer and consumer as separate processes", () => {
  afterAll(async () => {
    const cleanup = createDb(url);
    if (created.length) await cleanup.db.delete(meetings).where(inArray(meetings.id, created));
    await cleanup.close();
  });

  test("a late consumer starts at cursor 0, resumes on rerun, and a fresh identity replays everything", async () => {
    const producer = await start("producer", ["replay", "--count", "6", "--interval", "20"]).done;
    const meeting = meetingOf(producer.stdout);
    expect(meeting).toBeTruthy();

    const first = await start("consumer", ["--meeting", meeting, "--name", "late", "--idle-exit", "700"]).done;
    expect(field(first.stdout, "start_cursor")).toBe("0");
    expect(seqs(first.stdout)).toEqual([1, 2, 3, 4, 5, 6]);

    const second = await start("consumer", ["--meeting", meeting, "--name", "late", "--idle-exit", "500"]).done;
    expect(field(second.stdout, "start_cursor")).toBe("6");
    expect(seqs(second.stdout)).toEqual([]);

    const more = await start("producer", ["replay", "--meeting", meeting, "--count", "2", "--interval", "20"]).done;
    expect(field(more.stdout, "head")).toBe("6");

    const third = await start("consumer", ["--meeting", meeting, "--name", "late", "--idle-exit", "500"]).done;
    expect(field(third.stdout, "start_cursor")).toBe("6");
    expect(seqs(third.stdout)).toEqual([7, 8]);

    const fresh = await start("consumer", ["--meeting", meeting, "--fresh", "--idle-exit", "500"]).done;
    expect(field(fresh.stdout, "start_cursor")).toBe("0");
    expect(field(fresh.stdout, "name")).toBe(`consumer-${fresh.pid}`);
    expect(seqs(fresh.stdout)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  }, 60_000);

  test("a consumer started first receives a later producer's segments live via NOTIFY", async () => {
    const seed = await start("producer", ["replay", "--count", "1", "--interval", "10"]).done;
    const meeting = meetingOf(seed.stdout);

    const consumer = start("consumer", ["--meeting", meeting, "--name", "live", "--idle-exit", "2500"]);
    await Bun.sleep(1200);
    await start("producer", ["replay", "--meeting", meeting, "--count", "5", "--interval", "100"]).done;
    const result = await consumer.done;

    expect(seqs(result.stdout)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(field(result.stdout, "committed")).toBe("6");
  }, 60_000);

  test("two consumers with different names each get every segment, and the same name cannot run twice", async () => {
    const seed = await start("producer", ["replay", "--count", "3", "--interval", "10"]).done;
    const meeting = meetingOf(seed.stdout);

    const a = start("consumer", ["--meeting", meeting, "--name", "alpha", "--idle-exit", "1500"]);
    const b = start("consumer", ["--meeting", meeting, "--name", "beta", "--idle-exit", "1500"]);
    const [ra, rb] = await Promise.all([a.done, b.done]);
    expect(seqs(ra.stdout)).toEqual([1, 2, 3]);
    expect(seqs(rb.stdout)).toEqual([1, 2, 3]);

    const first = start("consumer", ["--meeting", meeting, "--name", "dup", "--idle-exit", "2500"]);
    await Bun.sleep(1000);
    const second = start("consumer", ["--meeting", meeting, "--name", "dup", "--idle-exit", "500"]);
    await expect(second.done).rejects.toThrow(/already running/);
    await first.done;
  }, 60_000);
});
