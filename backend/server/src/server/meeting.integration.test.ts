import { TEST_OWNER_ID, testOwner, testOwnerAuth } from "../auth/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { websocket } from "hono/bun";
import { createDb, type DbClient } from "../db/client";
import { ChatRepository, MeetingRepository } from "../db/repositories/meeting.repository";
import { MeetingParticipantRepository } from "../db/repositories/participant.repository";
import { SegmentRepository } from "../db/repositories/segment.repository";
import { meetings as meetingsTable, transcriptSegments } from "../db/schema";
import { env } from "../env";
import { PgWakeBridge, WakeHub } from "../log/wake";
import { LiveAudioSource } from "../producer/live-audio";
import type { SourceSegment, TranscriptSource } from "../producer/source";
import { createApp } from "./app";
import type { Frame, SegmentFrame } from "./frames";
import { MeetingController } from "./meeting-controller";

async function probe(): Promise<DbClient | null> {
  try {
    const client = createDb(env.DATABASE_URL);
    await client.db.select().from(transcriptSegments).limit(0);
    return client;
  } catch {
    return null;
  }
}

const client = await probe();
const run = client ? describe : describe.skip;

/** Emits one segment per interval until the signal aborts, like a live transcript. */
class TickSource implements TranscriptSource {
  constructor(
    private readonly everyMs = 20,
    private readonly failAfter = Infinity,
  ) {}
  async *stream(signal: AbortSignal): AsyncGenerator<SourceSegment> {
    for (let i = 0; i < this.failAfter && !signal.aborted; i++) {
      yield { text: `tick ${i}`, startMs: i * 1000, endMs: i * 1000 + 900, speakerKey: "spk_0" };
      await Bun.sleep(this.everyMs);
    }
    if (this.failAfter !== Infinity && !signal.aborted) throw new Error("source exploded");
  }
}

/** A live source that turns each pushed chunk into a segment, with no Deepgram. */
class EchoLiveSource extends LiveAudioSource {
  pushed = 0;
  constructor() {
    super({ baseMs: 0, deepgram: { apiKey: "k" } });
  }
  override push(chunk: Uint8Array): boolean {
    this.pushed++;
    return super.push(chunk);
  }
  override stream(signal: AbortSignal): AsyncIterable<SourceSegment> {
    const self = this;
    return (async function* () {
      let seen = 0;
      while (!signal.aborted && !self.isEnded) {
        if (self.pushed > seen) {
          yield { text: `audio ${seen}`, startMs: seen * 1000, endMs: seen * 1000 + 900 };
          seen++;
        } else {
          await Bun.sleep(10);
        }
      }
    })();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => Promise<boolean> | boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error("timed out waiting for condition");
}

run("meeting lifecycle (postgres)", () => {
  const { db, sql } = client ?? ({} as DbClient);
  const meetings = new MeetingRepository(db);
  const segments = new SegmentRepository(db);
  const hub = new WakeHub();
  const bridge = new PgWakeBridge(sql, hub);
  const started: string[] = [];
  const hostStarts: { meetingId: string; chatId: string }[] = [];
  let hasKey = true;
  let youtubeSource: () => TranscriptSource = () => new TickSource();
  let liveSource: EchoLiveSource | null = null;
  let controller: MeetingController;
  let server: ReturnType<typeof Bun.serve>;
  let http = "";
  let ws = "";

  const post = (path: string, body?: unknown) =>
    fetch(`${http}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const startYoutube = async () => {
    const response = await post("/meetings", {
      source: "youtube",
      url: "https://www.youtube.com/watch?v=7ARBJQn6QkM",
    });
    const json = (await response.json()) as { id?: string; meetingId?: string };
    if (json.id) started.push(json.id);
    return { response, json };
  };

  beforeAll(async () => {
    await testOwner(db);
    await bridge.start();
    controller = new MeetingController({
      sql,
      meetings,
      segments,
      chats: new ChatRepository(db),
      runner: { open: async () => undefined },
      host: { start: (meetingId, chatId) => void hostStarts.push({ meetingId, chatId }) },
      get deepgramApiKey() {
        return hasKey ? "test-key" : undefined;
      },
      endTimeoutMs: 5_000,
      appender: { retryBaseMs: 5, lockCheckMs: 0 },
      log: () => undefined,
      createYoutubeSource: async () => youtubeSource(),
      createLiveSource: () => (liveSource = new EchoLiveSource()),
    });
    const app = createApp({
      auth: testOwnerAuth(),
      meetings,
      segments,
      participants: new MeetingParticipantRepository(db),
      hub,
      heartbeatMs: 1_000,
      maxBufferedBytes: 1_000_000,
      meetingApi: controller,
    });
    server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
    http = `http://localhost:${server.port}`;
    ws = `ws://localhost:${server.port}`;
  });

  beforeEach(async () => {
    hasKey = true;
    youtubeSource = () => new TickSource();
    liveSource = null;
    hostStarts.length = 0;
    await controller.shutdown();
  });

  afterAll(async () => {
    await controller?.shutdown();
    await server?.stop(true);
    await bridge.stop();
    if (started.length) await meetings.deleteWhere(inArray(meetingsTable.id, started));
    await client?.close();
  });

  test("start goes live, streams segments, starts the chat consumer, and end persists everything", async () => {
    const { response, json } = await startYoutube();
    expect(response.status).toBe(201);
    expect(json).toMatchObject({ status: "live", source: "youtube" });
    const id = json.id!;

    expect(hostStarts).toHaveLength(1);
    expect(hostStarts[0]!.meetingId).toBe(id);

    const frames: Frame[] = [];
    const socket = new WebSocket(`${ws}/meetings/${id}/stream?after=0`);
    socket.onmessage = (event) => frames.push(JSON.parse(String(event.data)) as Frame);
    await until(() => frames.filter((f) => f.type === "segment").length >= 3);

    const ended = await post(`/meetings/${id}/end`);
    expect(ended.status).toBe(200);
    expect(await ended.json()).toMatchObject({ id, status: "ended", source: null });
    socket.close();

    expect(await segments.head(id)).toBeGreaterThanOrEqual(3);
    const seen = frames.filter((f): f is SegmentFrame => f.type === "segment").map((f) => f.seq);
    expect(seen).toEqual(seen.map((_, i) => i + 1));
    expect(controller.activeMeetingId(TEST_OWNER_ID)).toBeNull();
  });

  test("a second start while one is live is refused with the live meeting's id", async () => {
    const first = await startYoutube();
    const second = await startYoutube();
    expect(second.response.status).toBe(409);
    expect(second.json).toMatchObject({ meetingId: first.json.id });
  });

  test("end is idempotent and a new meeting can start afterwards", async () => {
    const first = await startYoutube();
    expect((await post(`/meetings/${first.json.id}/end`)).status).toBe(200);
    expect((await post(`/meetings/${first.json.id}/end`)).status).toBe(200);
    const second = await startYoutube();
    expect(second.response.status).toBe(201);
  });

  test("end on an unknown or malformed id is a 404", async () => {
    expect((await post("/meetings/not-a-uuid/end")).status).toBe(404);
    expect((await post("/meetings/00000000-0000-4000-8000-000000000000/end")).status).toBe(404);
  });

  test("a source that crashes ends the meeting and frees the slot", async () => {
    youtubeSource = () => new TickSource(5, 3);
    const { json } = await startYoutube();
    await until(async () => (await meetings.findById(json.id!))?.status === "ended");
    expect(controller.activeMeetingId(TEST_OWNER_ID)).toBeNull();
    expect(await segments.head(json.id!)).toBe(3);
    youtubeSource = () => new TickSource();
    expect((await startYoutube()).response.status).toBe(201);
  });

  test("rejects bad requests without creating a meeting", async () => {
    const before = (await meetings.listByUser(TEST_OWNER_ID, 200)).length;
    expect((await post("/meetings", { source: "tape" })).status).toBe(400);
    expect((await post("/meetings", { source: "youtube" })).status).toBe(400);
    expect((await post("/meetings", { source: "youtube", url: "not a youtube url" })).status).toBe(400);
    expect((await post("/meetings", { source: "youtube", url: "x", maxSeconds: 0 })).status).toBe(400);
    expect((await meetings.listByUser(TEST_OWNER_ID, 200)).length).toBe(before);
  });

  test("without a Deepgram key starting is unavailable, not a crash", async () => {
    hasKey = false;
    const response = await post("/meetings", { source: "live" });
    expect(response.status).toBe(503);
    expect(controller.activeMeetingId(TEST_OWNER_ID)).toBeNull();
  });

  test("lists meetings newest first and reports the running source", async () => {
    const { json } = await startYoutube();
    const listed = (await (await fetch(`${http}/meetings?limit=5`)).json()) as {
      meetings: { id: string; source: string | null }[];
    };
    expect(listed.meetings[0]).toMatchObject({ id: json.id, source: "youtube" });
    expect((await fetch(`${http}/meetings?limit=0`)).status).toBe(400);
    const one = await fetch(`${http}/meetings/${json.id}`);
    expect(await one.json()).toMatchObject({ id: json.id, status: "live" });
    expect((await fetch(`${http}/meetings/not-a-uuid`)).status).toBe(404);
  });

  test("live audio: chunks sent over the audio socket become segments, and end stops ingest", async () => {
    const response = await post("/meetings", { source: "live", title: "mic" });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    started.push(id);

    const audio = new WebSocket(`${ws}/meetings/${id}/audio`);
    await new Promise<void>((resolve, reject) => {
      audio.onopen = () => resolve();
      audio.onerror = () => reject(new Error("audio socket failed"));
    });
    for (let i = 0; i < 3; i++) audio.send(new Uint8Array(3200).fill(1));
    await until(async () => (await segments.head(id)) >= 3);
    expect(liveSource!.pushed).toBe(3);

    await post(`/meetings/${id}/end`);
    audio.close();
    expect((await meetings.findById(id))?.status).toBe("ended");
    expect(liveSource!.isEnded).toBe(true);

    const late = await fetch(`${http}/meetings/${id}/audio`);
    expect(late.status).toBe(409);
  });

  test("the audio socket is refused for a youtube meeting and for unknown ids", async () => {
    const { json } = await startYoutube();
    expect((await fetch(`${http}/meetings/${json.id}/audio`)).status).toBe(409);
    expect((await fetch(`${http}/meetings/00000000-0000-4000-8000-000000000000/audio`)).status).toBe(404);
  });

  test("shutdown ends the running meeting", async () => {
    const { json } = await startYoutube();
    await controller.shutdown();
    expect((await meetings.findById(json.id!))?.status).toBe("ended");
  });
});
