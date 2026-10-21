import { describe, expect, test } from "bun:test";
import { QueueOverflowError } from "./async-queue";
import { transcribeAudio, UnreadableStreamError, type DeepgramOptions } from "./deepgram";
import { Fmp4Tracker } from "./mp4";
import type { SourceSegment } from "./source";

class FakeSocket {
  readyState = 0;
  sent: (string | Uint8Array)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  serverClosesOnCloseStream = true;

  send(data: string | Uint8Array) {
    if (this.readyState !== 1) throw new Error("socket not open");
    this.sent.push(data);
    if (this.serverClosesOnCloseStream && typeof data === "string" && data.includes("CloseStream")) {
      setTimeout(() => this.drop(1000), 5);
    }
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code: 1000, reason: "" }));
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  drop(code: number) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
  result(text: string, start = 0, duration = 1) {
    this.onmessage?.({
      data: JSON.stringify({
        type: "Results",
        is_final: true,
        start,
        duration,
        channel: { alternatives: [{ transcript: text, words: [{ speaker: 0 }] }] },
      }),
    });
  }
  raw(data: string) {
    this.onmessage?.({ data });
  }
  binary() {
    return this.sent.filter((d) => typeof d !== "string").length;
  }
  closeStreams() {
    return this.sent.filter((d) => typeof d === "string" && d.includes("CloseStream")).length;
  }
}

function harness(overrides: Partial<DeepgramOptions> = {}, behavior: "open" | "refuse" = "open") {
  const sockets: FakeSocket[] = [];
  const options: DeepgramOptions = {
    apiKey: "k",
    reconnect: { maxAttempts: 2, baseMs: 1, maxMs: 2 },
    connect: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      setTimeout(() => (behavior === "refuse" ? socket.drop(1006) : socket.open()), 0);
      return socket as unknown as WebSocket;
    },
    ...overrides,
  };
  return { sockets, options };
}

async function* chunks(count: number, gapMs: number, signal?: AbortSignal) {
  for (let i = 0; i < count; i++) {
    if (signal?.aborted) return;
    yield new Uint8Array(8).fill(i); // at least a box header, so the stream can be classified
    await Bun.sleep(gapMs);
  }
}

async function collect(
  stream: AsyncIterable<SourceSegment>,
  onEach?: (segment: SourceSegment) => void,
) {
  const out: SourceSegment[] = [];
  for await (const segment of stream) {
    out.push(segment);
    onEach?.(segment);
  }
  return out;
}

describe("transcribeAudio reconnect", () => {
  test("a dropped socket reconnects, marks the outage as a gap and loses no audio", async () => {
    const { sockets, options } = harness();
    const abort = new AbortController();
    const total = 6;
    setTimeout(() => sockets[0]!.result("before", 0, 1), 15);

    const out = await collect(
      transcribeAudio(options, chunks(total, 25), abort.signal, 1_000),
      (segment) => {
        if (segment.text === "before") sockets[0]!.drop(1006);
        if (segment.source === "gap") sockets[1]!.result("after", 0, 1);
      },
    );

    expect(out.map((s) => s.text)).toEqual(["before", "", "after"]);
    const [before, gap, after] = out as [SourceSegment, SourceSegment, SourceSegment];
    expect(before).toMatchObject({ startMs: 1_000, endMs: 2_000 });
    expect(gap).toMatchObject({ source: "gap", startMs: 2_000, speakerKey: null });
    expect(gap.endMs).toBeGreaterThanOrEqual(gap.startMs);
    expect(after.startMs).toBe(gap.endMs);
    expect(sockets).toHaveLength(2);
    expect(sockets[0]!.binary() + sockets[1]!.binary()).toBe(total);
    expect(sockets[1]!.closeStreams()).toBe(1);
  });

  // 100-byte chunks at 1000 bytes/s: each chunk is 100 ms of audio, chunk i spans i*100..(i+1)*100.
  async function* audioChunks(count: number, gapMs: number) {
    for (let i = 0; i < count; i++) {
      yield new Uint8Array(100).fill(i);
      await Bun.sleep(gapMs);
    }
  }

  async function dropAfterFirstResult(options: DeepgramOptions, sockets: FakeSocket[]) {
    const abort = new AbortController();
    // The first connection transcribes 0..500 ms, then drops with more audio already sent.
    setTimeout(() => sockets[0]!.result("before", 0, 0.5), 60);
    let sentBefore = 0;
    const out = await collect(
      transcribeAudio(options, audioChunks(40, 5), abort.signal, 0),
      (segment) => {
        if (segment.text === "before") {
          sentBefore = sockets[0]!.binary();
          sockets[0]!.drop(1006);
        }
        if (segment.source !== "gap" && segment.text === "before") {
          setTimeout(() => sockets[1]!.result("after", 0, 0.2), 20);
        }
      },
    );
    return { out, sentBefore };
  }

  test("with a bitrate, audio sent but not transcribed is resent after a reconnect", async () => {
    const { sockets, options } = harness({ bytesPerSecond: 1000 });
    const { out, sentBefore } = await dropAfterFirstResult(options, sockets);

    expect(sentBefore).toBeGreaterThan(6);
    // Chunks 0..4 are already transcribed (0..500 ms); 5.. go to the new connection, in order.
    const resent = sockets[1]!.sent.filter((d): d is Uint8Array => typeof d !== "string");
    expect(resent.slice(0, sentBefore - 5).map((c) => c[0])).toEqual(
      Array.from({ length: sentBefore - 5 }, (_, i) => 5 + i),
    );
    // Nothing was lost, so there is no gap, and the new timeline starts where the replay does.
    expect(out.map((s) => s.source)).toEqual(["deepgram", "deepgram"]);
    expect(out[1]).toMatchObject({ text: "after", startMs: 500 });
  });

  test("audio older than the replay buffer becomes a gap on the audio timeline", async () => {
    const { sockets, options } = harness({ bytesPerSecond: 1000, replayBufferMs: 200 });
    const { out, sentBefore } = await dropAfterFirstResult(options, sockets);

    const gap = out.find((s) => s.source === "gap")!;
    const resent = sockets[1]!.sent.filter((d): d is Uint8Array => typeof d !== "string");
    const firstResent = resent[0]![0]!;
    expect(sentBefore).toBeGreaterThan(firstResent);
    expect(gap).toMatchObject({ startMs: 500, endMs: firstResent * 100 });
    expect(gap.endMs).toBeGreaterThan(500);
    expect(out.at(-1)).toMatchObject({ text: "after", startMs: gap.endMs });
  });

  test("without a bitrate nothing is resent and the gap is wall-clock time", async () => {
    const { sockets, options } = harness({});
    const { out, sentBefore } = await dropAfterFirstResult(options, sockets);
    expect(out.some((s) => s.source === "gap")).toBe(true);
    const resent = sockets[1]!.sent.filter((d): d is Uint8Array => typeof d !== "string");
    expect(resent[0]![0]).toBe(sentBefore); // continues where it left off, nothing resent
  });

  describe("fragmented MP4 audio", () => {
    const box = (type: string, payload: Uint8Array) => {
      const out = new Uint8Array(8 + payload.length);
      new DataView(out.buffer).setUint32(0, out.length);
      out.set(new TextEncoder().encode(type), 4);
      out.set(payload, 8);
      return out;
    };
    const cat = (...parts: Uint8Array[]) => {
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) (out.set(p, at), (at += p.length));
      return out;
    };
    const init = cat(box("ftyp", new Uint8Array(8)), box("moov", new Uint8Array(40)));
    // 600-byte fragments: moof (16) + mdat (584). At 1000 bytes/s a fragment is 600 ms.
    const fragment = (n: number) => cat(box("moof", new Uint8Array([n, n])), box("mdat", new Uint8Array(576).fill(n)));
    const FRAGMENTS = 30;
    const file = cat(init, box("sidx", new Uint8Array(32)), ...Array.from({ length: FRAGMENTS }, (_, i) => fragment(i + 1)));

    async function* feedFile(chunk: number, gapMs: number) {
      for (let at = 0; at < file.length; at += chunk) {
        yield file.slice(at, at + chunk);
        await Bun.sleep(gapMs);
      }
    }

    const binary = (socket: FakeSocket) =>
      cat(...socket.sent.filter((d): d is Uint8Array => typeof d !== "string"));

    // Reads what a socket was sent as a decoder would: init first, then whole fragments.
    function inspect(bytes: Uint8Array) {
      const tracker = new Fmp4Tracker();
      const out = tracker.push(bytes);
      const ids = out.fragments.map((f) => f.data[8]!); // first payload byte of the moof
      return { active: tracker.active, forwarded: out.forward.length, total: bytes.length, ids, partial: tracker.partial() };
    }

    async function run(overrides: Partial<DeepgramOptions>) {
      const { sockets, options } = harness({ ...overrides });
      const abort = new AbortController();
      setTimeout(() => sockets[0]!.result("before", 0, 1.5), 80);
      let sentBefore = new Uint8Array(0);
      const out = await collect(
        transcribeAudio(options, feedFile(300, 4), abort.signal, 0),
        (segment) => {
          if (segment.text === "before") {
            sentBefore = binary(sockets[0]!);
            sockets[0]!.drop(1006);
            setTimeout(() => sockets[1]!.result("after", 0.2, 0.5), 40);
          }
        },
      );
      return { out, sockets, sentBefore };
    }

    test("the first connection gets a clean init segment and fragments, without index boxes", async () => {
      const { sockets } = await run({ bytesPerSecond: 1000 });
      const first = inspect(binary(sockets[0]!));
      expect(first.active).toBe(true);
      expect(first.forwarded).toBe(first.total); // nothing but ftyp, moov, moof and mdat was sent
      expect(first.ids.slice(0, 3)).toEqual([1, 2, 3]);
    });

    test("after a reconnect the new connection starts with the init segment and whole fragments", async () => {
      const { sockets, sentBefore, out } = await run({ bytesPerSecond: 1000 });
      expect(sentBefore.length).toBeGreaterThan(init.length + 4 * 600);

      const second = binary(sockets[1]!);
      expect(Array.from(second.subarray(4, 8))).toEqual(Array.from(new TextEncoder().encode("ftyp")));
      expect(second.subarray(0, init.length)).toEqual(init);
      const seen = inspect(second);
      expect(seen.active).toBe(true);
      expect(seen.forwarded).toBe(seen.total); // every box is whole and in order
      // Fragments are consecutive: replayed ones, then the rest of the file, none skipped.
      for (let i = 1; i < seen.ids.length; i++) expect(seen.ids[i]).toBe(seen.ids[i - 1]! + 1);
      // Transcribed up to 1500 ms, so replay starts at the fragment containing it (#3 = 1200..1800 ms).
      expect(seen.ids[0]).toBe(3);
      expect(seen.ids.at(-1)).toBe(FRAGMENTS);
      expect(out.map((s) => s.text)).toEqual(["before", "after"]);
      expect(out.some((s) => s.source === "gap")).toBe(false);
    });

    test("a gap covers fragments the buffer no longer holds", async () => {
      const { sockets, out } = await run({ bytesPerSecond: 1000, replayBufferMs: 1500 });
      const gap = out.find((s) => s.source === "gap")!;
      const seen = inspect(binary(sockets[1]!));
      expect(seen.forwarded).toBe(seen.total);
      expect(seen.ids[0]).toBeGreaterThan(3);
      expect(gap.startMs).toBe(1500);
      expect(gap.endMs).toBeGreaterThan(1500);
    });

    test("without a bitrate the new connection still gets the init segment and the fragment in progress", async () => {
      const { sockets } = await run({});
      const second = binary(sockets[1]!);
      expect(second.subarray(0, init.length)).toEqual(init);
      const seen = inspect(second);
      expect(seen.active).toBe(true);
      expect(seen.forwarded).toBe(seen.total);
    });
  });

  test("gives up after maxAttempts failed connections", async () => {
    const { sockets, options } = harness({}, "refuse");
    const abort = new AbortController();
    await expect(collect(transcribeAudio(options, chunks(3, 5), abort.signal, 0))).rejects.toThrow(
      /deepgram closed 1006/,
    );
    expect(sockets).toHaveLength(3);
  });

  test("sessions that drop before yielding anything do not reset the failure budget", async () => {
    const { sockets, options } = harness();
    const abort = new AbortController();
    const original = options.connect!;
    options.connect = (url, protocols) => {
      const socket = original(url, protocols) as unknown as FakeSocket;
      setTimeout(() => socket.drop(1011), 10);
      return socket as unknown as WebSocket;
    };
    await expect(collect(transcribeAudio(options, chunks(50, 5), abort.signal, 0))).rejects.toThrow(
      /deepgram closed 1011/,
    );
    expect(sockets).toHaveLength(3);
  });
});

describe("transcribeAudio abort", () => {
  test("sends CloseStream and still yields the utterance Deepgram flushes", async () => {
    const { sockets, options } = harness();
    const abort = new AbortController();

    setTimeout(() => {
      sockets[0]!.serverClosesOnCloseStream = false;
      abort.abort();
      setTimeout(() => {
        sockets[0]!.result("last words", 0, 1);
        sockets[0]!.drop(1000);
      }, 10);
    }, 30);

    const out = await collect(
      transcribeAudio(options, chunks(100, 10, abort.signal), abort.signal, 0),
    );

    expect(sockets[0]!.closeStreams()).toBe(1);
    expect(out.map((s) => s.text)).toEqual(["last words"]);
  });

  test("closes the socket itself when Deepgram never answers the flush", async () => {
    const { sockets, options } = harness({ flushTimeoutMs: 20 });
    const abort = new AbortController();
    setTimeout(() => {
      sockets[0]!.serverClosesOnCloseStream = false;
      abort.abort();
    }, 20);

    const out = await collect(
      transcribeAudio(options, chunks(100, 10, abort.signal), abort.signal, 0),
    );

    expect(out).toEqual([]);
    expect(sockets[0]!.readyState).toBe(3);
  });
});

describe("transcribeAudio backlog", () => {
  test("fails loudly instead of growing without bound when the consumer stalls", async () => {
    const { sockets, options } = harness({ maxBuffered: 2 });
    const abort = new AbortController();
    const got: string[] = [];
    setTimeout(() => sockets[0]!.result("first", 0, 1), 10);

    const run = (async () => {
      for await (const segment of transcribeAudio(
        options,
        chunks(100, 5, abort.signal),
        abort.signal,
        0,
      )) {
        got.push(segment.text);
        if (got.length === 1) {
          for (let i = 0; i < 6; i++) sockets[0]!.result(`r${i}`, i, 1);
        }
      }
    })();

    await expect(run).rejects.toBeInstanceOf(QueueOverflowError);
    abort.abort();
    expect(got).toEqual(["first", "r0", "r1"]);
  });

  test("pauses the audio pump while the queue is above the high-water mark", async () => {
    const { sockets, options } = harness({ maxBuffered: 4 });
    const abort = new AbortController();
    let sentWhileFull = Infinity;
    setTimeout(() => sockets[0]!.result("first", 0, 1), 10);

    const run = (async () => {
      for await (const segment of transcribeAudio(
        options,
        chunks(200, 2, abort.signal),
        abort.signal,
        0,
      )) {
        if (segment.text !== "first") continue;
        sockets[0]!.result("a", 1, 1);
        sockets[0]!.result("b", 2, 1);
        const before = sockets[0]!.binary();
        await Bun.sleep(200);
        sentWhileFull = sockets[0]!.binary() - before;
        abort.abort();
      }
    })();

    await run.catch(() => undefined);
    expect(sentWhileFull).toBeLessThanOrEqual(1);
  });
});

describe("transcribeAudio unreadable messages", () => {
  test("a few unreadable messages are reported and skipped, the stream carries on", async () => {
    const warnings: string[] = [];
    const { sockets, options } = harness({ onWarn: (m) => warnings.push(m) });
    const abort = new AbortController();
    setTimeout(() => {
      sockets[0]!.raw("not json");
      sockets[0]!.raw("{broken");
      sockets[0]!.result("still fine", 0, 1);
    }, 15);

    const out = await collect(transcribeAudio(options, chunks(4, 20), abort.signal, 0));

    expect(out.map((s) => s.text)).toEqual(["still fine"]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("not json");
  });

  test("a run of unreadable messages fails the stream instead of reconnecting forever", async () => {
    const { sockets, options } = harness({ maxUnreadable: 5 });
    const abort = new AbortController();
    setTimeout(() => {
      sockets[0]!.result("before", 0, 1);
      for (let i = 0; i < 5; i++) sockets[0]!.raw("garbage");
    }, 15);

    const seen: string[] = [];
    await expect(
      collect(transcribeAudio(options, chunks(50, 10), abort.signal, 0), (s) => seen.push(s.text)),
    ).rejects.toBeInstanceOf(UnreadableStreamError);
    expect(seen).toEqual(["before"]);
    expect(sockets).toHaveLength(1); // no reconnect attempts
  });

  test("a good message resets the count, so scattered bad ones never trip the limit", async () => {
    const { sockets, options } = harness({ maxUnreadable: 3 });
    const abort = new AbortController();
    setTimeout(() => {
      for (let i = 0; i < 6; i++) {
        sockets[0]!.raw("bad");
        sockets[0]!.raw("bad");
        sockets[0]!.result(`ok ${i}`, i, 1);
      }
    }, 15);
    const out = await collect(transcribeAudio(options, chunks(4, 20), abort.signal, 0));
    expect(out).toHaveLength(6);
  });
});
