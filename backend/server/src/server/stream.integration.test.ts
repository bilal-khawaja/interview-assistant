import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { websocket } from "hono/bun";
import { createDb, type DbClient } from "../db/client";
import { MeetingRepository } from "../db/repositories/meeting.repository";
import {
  MeetingParticipantRepository,
  PersonRepository,
} from "../db/repositories/participant.repository";
import { SegmentRepository } from "../db/repositories/segment.repository";
import { meetings as meetingsTable, transcriptSegments } from "../db/schema";
import { env } from "../env";
import { SegmentAppender } from "../log/append";
import { PgWakeBridge, WakeHub } from "../log/wake";
import { createApp } from "./app";
import type { Frame, SegmentFrame } from "./frames";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Socket = {
  frames: Frame[];
  closed: Promise<{ code: number; reason: string }>;
  waitFor(predicate: (frames: Frame[]) => boolean, ms?: number): Promise<void>;
  close(): void;
};

function connect(url: string): Socket {
  const ws = new WebSocket(url);
  const frames: Frame[] = [];
  const listeners = new Set<() => void>();
  ws.onmessage = (event) => {
    frames.push(JSON.parse(String(event.data)) as Frame);
    for (const listener of listeners) listener();
  };
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.onclose = (event) => resolve({ code: event.code, reason: event.reason });
  });
  return {
    frames,
    closed,
    waitFor(predicate, ms = 5_000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          if (!predicate(frames)) return;
          listeners.delete(check);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`timed out; frames=${JSON.stringify(frames.map((f) => f.type))}`));
        }, ms);
        listeners.add(check);
        check();
      });
    },
    close: () => ws.close(),
  };
}

const segs = (frames: Frame[]) =>
  frames.filter((f): f is SegmentFrame => f.type === "segment");
const seqs = (frames: Frame[]) => segs(frames).map((f) => f.seq);

run("transcript websocket (postgres)", () => {
  const { db, sql } = client ?? ({} as DbClient);
  const meetings = new MeetingRepository(db);
  const segments = new SegmentRepository(db);
  const people = new PersonRepository(db);
  const participants = new MeetingParticipantRepository(db);
  const hub = new WakeHub();
  const bridge = new PgWakeBridge(sql, hub);
  const created: string[] = [];
  let server: ReturnType<typeof Bun.serve>;
  let base = "";

  const newMeeting = async () => {
    const meeting = await meetings.create("ws");
    created.push(meeting.id);
    return meeting;
  };
  const open = (meetingId: string) =>
    SegmentAppender.open({ sql, segments, retryBaseMs: 5 }, meetingId);
  const draft = (i: number, speakerKey?: string) => ({
    text: `seg ${i}`,
    startMs: i * 1000,
    endMs: i * 1000 + 900,
    speakerKey,
  });
  const url = (meetingId: string, after?: string | number) =>
    `${base}/meetings/${meetingId}/stream${after === undefined ? "" : `?after=${after}`}`;

  beforeAll(async () => {
    await bridge.start();
    const app = createApp({
      meetings,
      segments,
      participants,
      hub,
      heartbeatMs: 80,
      maxBufferedBytes: 1_000_000,
    });
    server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
    base = `ws://localhost:${server.port}`;
  });

  afterAll(async () => {
    await server?.stop(true);
    await bridge.stop();
    if (created.length) await meetings.deleteWhere(inArray(meetingsTable.id, created));
    await client?.close();
  });

  test("healthz responds over plain http", async () => {
    const response = await fetch(`http://localhost:${server.port}/healthz`);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("replays from after=N exactly, then streams live appends", async () => {
    const m = await newMeeting();
    const producer = await open(m.id);
    for (let i = 1; i <= 5; i++) await producer.append(draft(i));

    const socket = connect(url(m.id, 2));
    await socket.waitFor((f) => seqs(f).length === 3);
    expect(socket.frames[0]).toMatchObject({ type: "ready", after: 2, head: 5, meetingId: m.id });
    expect(seqs(socket.frames)).toEqual([3, 4, 5]);

    await producer.append(draft(6));
    await producer.append(draft(7));
    await socket.waitFor((f) => seqs(f).length === 5);
    expect(seqs(socket.frames)).toEqual([3, 4, 5, 6, 7]);

    socket.close();
    await producer.close();
  });

  test("after defaults to 0 and replays the whole log", async () => {
    const m = await newMeeting();
    const producer = await open(m.id);
    for (let i = 1; i <= 3; i++) await producer.append(draft(i));

    const socket = connect(url(m.id));
    await socket.waitFor((f) => seqs(f).length === 3);
    expect(seqs(socket.frames)).toEqual([1, 2, 3]);
    socket.close();
    await producer.close();
  });

  test("a dropped connection resumes from its last seq with no gap and no duplicate", async () => {
    const m = await newMeeting();
    const producer = await open(m.id);
    for (let i = 1; i <= 3; i++) await producer.append(draft(i));

    const first = connect(url(m.id, 0));
    await first.waitFor((f) => seqs(f).length === 3);
    const lastSeen = seqs(first.frames).at(-1)!;
    first.close();
    await first.closed;

    for (let i = 4; i <= 8; i++) await producer.append(draft(i));

    const second = connect(url(m.id, lastSeen));
    await second.waitFor((f) => seqs(f).length === 5);
    await producer.append(draft(9));
    await second.waitFor((f) => seqs(f).length === 6);

    const all = [...seqs(first.frames), ...seqs(second.frames)];
    expect(all).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    second.close();
    await producer.close();
  });

  test("two tabs on the same meeting both receive the same stream", async () => {
    const m = await newMeeting();
    const producer = await open(m.id);
    await producer.append(draft(1));

    const a = connect(url(m.id, 0));
    const b = connect(url(m.id, 0));
    await Promise.all([a.waitFor((f) => seqs(f).length === 1), b.waitFor((f) => seqs(f).length === 1)]);
    for (let i = 2; i <= 6; i++) await producer.append(draft(i));
    await Promise.all([a.waitFor((f) => seqs(f).length === 6), b.waitFor((f) => seqs(f).length === 6)]);

    expect(seqs(a.frames)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(seqs(b.frames)).toEqual([1, 2, 3, 4, 5, 6]);
    a.close();
    b.close();
    await producer.close();
  });

  test("a tab joining mid-meeting starts at its own cursor without affecting the first", async () => {
    const m = await newMeeting();
    const producer = await open(m.id);
    for (let i = 1; i <= 4; i++) await producer.append(draft(i));

    const early = connect(url(m.id, 0));
    await early.waitFor((f) => seqs(f).length === 4);
    const late = connect(url(m.id, 3));
    await late.waitFor((f) => seqs(f).length === 1);
    await producer.append(draft(5));
    await Promise.all([early.waitFor((f) => seqs(f).length === 5), late.waitFor((f) => seqs(f).length === 2)]);

    expect(seqs(early.frames)).toEqual([1, 2, 3, 4, 5]);
    expect(seqs(late.frames)).toEqual([4, 5]);
    early.close();
    late.close();
    await producer.close();
  });

  test("sends heartbeats while idle", async () => {
    const m = await newMeeting();
    const socket = connect(url(m.id));
    await socket.waitFor((f) => f.filter((x) => x.type === "heartbeat").length >= 2);
    expect(socket.frames[0]).toMatchObject({ type: "ready", heartbeatMs: 80, head: 0 });
    socket.close();
  });

  test("rejects a bad cursor and an unknown meeting before the upgrade", async () => {
    const m = await newMeeting();
    const http = (path: string) => fetch(`http://localhost:${server.port}${path}`);

    expect((await http(`/meetings/${m.id}/stream?after=-1`)).status).toBe(400);
    expect((await http(`/meetings/${m.id}/stream?after=abc`)).status).toBe(400);
    expect((await http(`/meetings/${m.id}/stream?after=1.5`)).status).toBe(400);
    expect((await http(`/meetings/${crypto.randomUUID()}/stream`)).status).toBe(404);
    expect((await http(`/meetings/not-a-uuid/stream`)).status).toBe(404);
  });

  test("a cursor ahead of the head gets an error frame and close code 4409", async () => {
    const m = await newMeeting();
    const producer = await open(m.id);
    await producer.append(draft(1));

    const socket = connect(url(m.id, 50));
    const closed = await socket.closed;
    expect(closed.code).toBe(4409);
    expect(socket.frames).toEqual([expect.objectContaining({ type: "error", code: "cursor_ahead" })]);
    await producer.close();
  });

  test("segments carry the resolved speaker without leaking email or phone", async () => {
    const m = await newMeeting();
    const email = `ws-${crypto.randomUUID()}@example.com`;
    const candidate = await people.create({
      fullName: "Ada Lovelace",
      email,
      phone: "555-0100",
      organization: "Analytical Engines",
    });
    await participants.add({
      meetingId: m.id,
      personId: candidate.id,
      role: "candidate",
      label: "Candidate",
      speakerKey: "spk_0",
    });
    const producer = await open(m.id);
    await producer.append(draft(1, "spk_0"));
    await producer.append(draft(2, "spk_1"));

    const socket = connect(url(m.id));
    await socket.waitFor((f) => seqs(f).length === 2);
    const [first, second] = segs(socket.frames);
    expect(first?.speaker).toMatchObject({
      role: "candidate",
      label: "Candidate",
      person: { fullName: "Ada Lovelace", organization: "Analytical Engines" },
    });
    expect(second?.speaker).toBeNull();
    const raw = JSON.stringify(socket.frames);
    expect(raw).not.toContain(email);
    expect(raw).not.toContain("555-0100");

    socket.close();
    await producer.close();
    await sleep(10);
  });

  test("closing a socket releases its wake subscription", async () => {
    const m = await newMeeting();
    const before = hub.size();
    const socket = connect(url(m.id));
    await socket.waitFor((f) => f.some((x) => x.type === "ready"));
    await sleep(50);
    expect(hub.size()).toBe(before + 1);

    socket.close();
    await socket.closed;
    const end = Date.now() + 2_000;
    while (hub.size() !== before && Date.now() < end) await sleep(20);
    expect(hub.size()).toBe(before);
  });
});
