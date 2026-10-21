import { describe, expect, test } from "bun:test";
import type { TranscriptSegment } from "../db/schema";
import { WakeHub } from "../log/wake";
import { CLOSE_CURSOR_AHEAD, CLOSE_INTERNAL_ERROR, CLOSE_SLOW_CONSUMER, type Frame } from "./frames";
import { runTranscriptStream, type StreamDeps, type StreamSink } from "./transcript-stream";

const MEETING = "m1";

function seg(seq: number, speakerKey: string | null = null): TranscriptSegment {
  return {
    id: seq,
    meetingId: MEETING,
    seq,
    speakerKey,
    text: `s${seq}`,
    startMs: seq * 1000,
    endMs: seq * 1000 + 900,
    source: "stt",
    createdAt: new Date(0),
  };
}

function harness(initial: number[] = [], options: Partial<StreamDeps> = {}) {
  const rows = initial.map((n) => seg(n));
  const hub = new WakeHub();
  const deps: StreamDeps = {
    segments: {
      head: async () => rows.at(-1)?.seq ?? 0,
      readAfter: async (_m, after, limit) => rows.filter((r) => r.seq > after).slice(0, limit),
    },
    participants: { listForMeeting: async () => [] },
    hub,
    heartbeatMs: 60_000,
    maxBufferedBytes: 1_000_000,
    pollMs: 60_000,
    ...options,
  };
  const frames: Frame[] = [];
  const closes: { code: number; reason: string }[] = [];
  let buffered = 0;
  const sink: StreamSink = {
    send: (frame) => void frames.push(frame),
    bufferedAmount: () => buffered,
    close: (code, reason) => void closes.push({ code, reason }),
  };
  const append = (...seqs: number[]) => {
    for (const n of seqs) rows.push(seg(n));
    hub.wake(MEETING);
  };
  return { deps, sink, frames, closes, append, hub, setBuffered: (n: number) => (buffered = n) };
}

const seqs = (frames: Frame[]) => frames.flatMap((f) => (f.type === "segment" ? [f.seq] : []));
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("runTranscriptStream", () => {
  test("sends ready, then replays everything after the cursor in order", async () => {
    const h = harness([1, 2, 3, 4, 5]);
    const ac = new AbortController();
    const done = runTranscriptStream(h.deps, h.sink, MEETING, 2, ac.signal);
    await tick();

    expect(h.frames[0]).toMatchObject({ type: "ready", stream: "transcript", meetingId: MEETING, after: 2, head: 5 });
    expect(seqs(h.frames)).toEqual([3, 4, 5]);

    ac.abort();
    await done;
    expect(h.hub.size()).toBe(0);
  });

  test("goes live after the replay with no gap or duplicate", async () => {
    const h = harness([1, 2]);
    const ac = new AbortController();
    const done = runTranscriptStream(h.deps, h.sink, MEETING, 0, ac.signal);
    await tick();
    h.append(3);
    await tick();
    h.append(4, 5);
    await tick();

    expect(seqs(h.frames)).toEqual([1, 2, 3, 4, 5]);
    ac.abort();
    await done;
  });

  test("a cursor beyond the head is rejected with an error frame and close 4409", async () => {
    const h = harness([1, 2, 3]);
    await runTranscriptStream(h.deps, h.sink, MEETING, 9, new AbortController().signal);

    expect(h.frames).toEqual([
      expect.objectContaining({ type: "error", code: "cursor_ahead" }),
    ]);
    expect(h.closes).toEqual([{ code: CLOSE_CURSOR_AHEAD, reason: "cursor ahead of head" }]);
    expect(h.hub.size()).toBe(0);
  });

  test("an empty log with after=0 is valid and goes live", async () => {
    const h = harness([]);
    const ac = new AbortController();
    const done = runTranscriptStream(h.deps, h.sink, MEETING, 0, ac.signal);
    await tick();
    expect(h.frames[0]).toMatchObject({ type: "ready", head: 0 });
    h.append(1);
    await tick();
    expect(seqs(h.frames)).toEqual([1]);
    ac.abort();
    await done;
  });

  test("heartbeats are sent on the interval and stop after abort", async () => {
    const h = harness([], { heartbeatMs: 20 });
    const ac = new AbortController();
    const done = runTranscriptStream(h.deps, h.sink, MEETING, 0, ac.signal);
    await tick(110);
    const beats = h.frames.filter((f) => f.type === "heartbeat").length;
    expect(beats).toBeGreaterThanOrEqual(3);

    ac.abort();
    await done;
    const after = h.frames.length;
    await tick(60);
    expect(h.frames.length).toBe(after);
  });

  test("a slow consumer is closed with 1013 instead of buffering without bound", async () => {
    const h = harness([1, 2, 3], { maxBufferedBytes: 100 });
    h.setBuffered(5_000);
    await runTranscriptStream(h.deps, h.sink, MEETING, 0, new AbortController().signal);

    expect(h.closes).toEqual([{ code: CLOSE_SLOW_CONSUMER, reason: "slow consumer" }]);
    expect(h.hub.size()).toBe(0);
  });

  test("a read failure becomes an error frame and close 1011, but an abort is silent", async () => {
    const failing = harness([1], {
      segments: {
        head: async () => 1,
        readAfter: async () => {
          throw new Error("db down");
        },
      },
    });
    await runTranscriptStream(failing.deps, failing.sink, MEETING, 0, new AbortController().signal);
    expect(failing.frames.at(-1)).toMatchObject({ type: "error", code: "internal", message: "db down" });
    expect(failing.closes[0]?.code).toBe(CLOSE_INTERNAL_ERROR);

    const aborted = harness([1]);
    const ac = new AbortController();
    const done = runTranscriptStream(aborted.deps, aborted.sink, MEETING, 0, ac.signal);
    await tick();
    ac.abort();
    await done;
    expect(aborted.closes).toEqual([]);
  });

  test("a database outage sends degraded, retries, then recovered, with no gap or duplicate", async () => {
    const outage = Object.assign(new Error("connection closed"), { code: "ERR_POSTGRES_CONNECTION_CLOSED" });
    let down = false;
    const h = harness([1, 2], { retryBaseMs: 5, retryMaxMs: 10, pollMs: 10 });
    const real = h.deps.segments.readAfter;
    h.deps.segments.readAfter = async (m, after, limit) => {
      if (down) throw outage;
      return real(m, after, limit);
    };
    const ac = new AbortController();
    const done = runTranscriptStream(h.deps, h.sink, MEETING, 0, ac.signal);
    await tick();
    expect(seqs(h.frames)).toEqual([1, 2]);

    down = true;
    h.append(3);
    await tick(60);
    expect(h.frames.filter((f) => f.type === "degraded")).toHaveLength(1); // once, not per retry
    expect(h.closes).toEqual([]);

    down = false;
    await tick(60);
    expect(seqs(h.frames)).toEqual([1, 2, 3]);
    const types = h.frames.map((f) => f.type);
    expect(types.indexOf("degraded")).toBeLessThan(types.indexOf("recovered"));
    expect(h.closes).toEqual([]);

    ac.abort();
    await done;
  });

  test("an abort during an outage ends the stream quietly", async () => {
    const outage = Object.assign(new Error("refused"), { code: "ERR_POSTGRES_CONNECTION_REFUSED" });
    const h = harness([1], { retryBaseMs: 5, retryMaxMs: 10 });
    h.deps.segments.readAfter = async () => {
      throw outage;
    };
    const ac = new AbortController();
    const done = runTranscriptStream(h.deps, h.sink, MEETING, 0, ac.signal);
    await tick(40);
    ac.abort();
    await done;
    expect(h.closes).toEqual([]);
    expect(h.hub.size()).toBe(0);
  });

  test("resolves speakers from the participant roster and leaves unmapped keys null", async () => {
    const h = harness([], {
      participants: {
        listForMeeting: async () => [
          {
            participant: { id: "p1", meetingId: MEETING, personId: "x", role: "candidate", label: "Candidate", speakerKey: "spk_0", createdAt: new Date(0) },
            person: { id: "x", fullName: "Ada Lovelace", email: "ada@example.com", organization: "Engines", jobTitle: "Engineer", phone: "123", createdAt: new Date(0) },
          },
        ],
      },
    });
    const ac = new AbortController();
    const done = runTranscriptStream(h.deps, h.sink, MEETING, 0, ac.signal);
    await tick();
    h.append(1, 2);
    const rows = [seg(1, "spk_0"), seg(2, "spk_9")];
    h.deps.segments.readAfter = async (_m, after) => rows.filter((r) => r.seq > after);
    h.hub.wake(MEETING);
    await tick(40);

    const frames = h.frames.filter((f) => f.type === "segment");
    expect(frames[0]).toMatchObject({
      speakerKey: "spk_0",
      speaker: { role: "candidate", label: "Candidate", person: { fullName: "Ada Lovelace", organization: "Engines" } },
    });
    expect(JSON.stringify(frames[0])).not.toContain("ada@example.com");
    expect(JSON.stringify(frames[0])).not.toContain("123");
    expect(frames[1]).toMatchObject({ speakerKey: "spk_9", speaker: null });

    ac.abort();
    await done;
  });
});
