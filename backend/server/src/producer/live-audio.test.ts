import { describe, expect, test } from "bun:test";
import { LiveAudioSource, LIVE_BYTES_PER_SECOND } from "./live-audio";

class FakeSocket {
  readyState = 0;
  sent: (string | Uint8Array)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string | Uint8Array) {
    this.sent.push(data);
    if (typeof data === "string" && data.includes("CloseStream")) {
      setTimeout(() => this.close(), 2);
    }
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: "" });
  }
  binary(): Uint8Array {
    const parts = this.sent.filter((d): d is Uint8Array => typeof d !== "string");
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

function harness(options: { idleTimeoutMs?: number; maxBufferedMs?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const dropped: number[] = [];
  const source = new LiveAudioSource({
    baseMs: 0,
    ...options,
    onDrop: (n) => dropped.push(n),
    deepgram: {
      apiKey: "k",
      reconnect: { maxAttempts: 1, baseMs: 1, maxMs: 2 },
      connect: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        setTimeout(() => {
          socket.readyState = 1;
          socket.onopen?.();
        }, 0);
        return socket as unknown as WebSocket;
      },
    },
  });
  const abort = new AbortController();
  const done = (async () => {
    for await (const _ of source.stream(abort.signal)) void _;
  })();
  return { source, sockets, dropped, abort, done };
}

const pcm = (bytes: number, fill = 1) => new Uint8Array(bytes).fill(fill);

describe("LiveAudioSource", () => {
  test("declares headerless 16 kHz PCM and forwards pushed audio in order", async () => {
    const { source, sockets, done } = harness();
    source.push(pcm(3200, 1));
    source.push(pcm(3200, 2));
    await Bun.sleep(80);
    source.end();
    await done;

    expect(sockets).toHaveLength(1);
    const bytes = sockets[0]!.binary();
    expect(bytes.length).toBe(6400);
    expect(bytes[0]).toBe(1);
    expect(bytes[6399]).toBe(2);
    expect(sockets[0]!.sent.some((d) => typeof d === "string" && d.includes("CloseStream"))).toBe(true);
  });

  test("stitches a chunk split mid-sample so samples stay two bytes", async () => {
    const { source, sockets, done } = harness();
    source.push(new Uint8Array([1, 2, 3]));
    source.push(new Uint8Array([4, 5, 6, 7, 8, 9, 10, 11, 12]));
    await Bun.sleep(80);
    source.end();
    await done;

    expect([...sockets[0]!.binary()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  test("silence (all-zero PCM) is sent through, not mistaken for a container", async () => {
    const { source, sockets, done } = harness();
    source.push(pcm(3200, 0));
    source.push(pcm(3200, 0));
    await Bun.sleep(80);
    source.end();
    await done;

    expect(sockets[0]!.binary().length).toBe(6400);
  });

  test("drops the oldest audio past the buffer limit and reports it", async () => {
    const { source, dropped, abort, done } = harness({ maxBufferedMs: 1_000 });
    // Nothing reads until the socket opens, so this backs up beyond one second.
    for (let i = 0; i < 4; i++) source.push(pcm(LIVE_BYTES_PER_SECOND / 2, i));
    expect(dropped.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(source.droppedBytes).toBe(dropped.reduce((a, b) => a + b, 0));
    abort.abort();
    await done;
  });

  test("ends on its own after the idle timeout", async () => {
    const { source, done } = harness({ idleTimeoutMs: 150 });
    source.push(pcm(3200));
    await done;
    expect(source.isEnded).toBe(true);
  });

  test("push after end is refused", async () => {
    const { source, done } = harness();
    source.end();
    await done;
    expect(source.push(pcm(2))).toBe(false);
  });

  test("aborting stops the stream even while idle", async () => {
    const { abort, done } = harness();
    await Bun.sleep(30);
    abort.abort();
    await done;
  });
});
