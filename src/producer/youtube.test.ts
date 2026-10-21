import { describe, expect, test } from "bun:test";
import {
  DownloadError,
  InvalidYoutubeUrlError,
  downloadInRanges,
  paceByBitrate,
  parseVideoId,
  primed,
} from "./youtube";

const ID = "jNQXAC9IVRw";

describe("parseVideoId", () => {
  test("accepts the common url shapes and a bare id", () => {
    for (const input of [
      ID,
      `https://www.youtube.com/watch?v=${ID}`,
      `https://www.youtube.com/watch?v=${ID}&t=42s`,
      `https://youtu.be/${ID}`,
      `https://youtu.be/${ID}?si=abc`,
      `https://m.youtube.com/watch?v=${ID}`,
      `https://www.youtube.com/shorts/${ID}`,
      `https://www.youtube.com/embed/${ID}`,
    ]) {
      expect(parseVideoId(input)).toBe(ID);
    }
  });

  test("rejects anything without a valid id", () => {
    for (const input of ["", "not a url", "https://example.com/watch?v=" + ID, "https://youtu.be/short"]) {
      expect(() => parseVideoId(input)).toThrow(InvalidYoutubeUrlError);
    }
  });
});

async function* chunks(...sizes: number[]) {
  for (const size of sizes) yield new Uint8Array(size);
}

async function collect(iterable: AsyncIterable<Uint8Array>) {
  const sizes: number[] = [];
  for await (const chunk of iterable) sizes.push(chunk.length);
  return sizes;
}

describe("paceByBitrate", () => {
  test("passes everything through unthrottled when not realtime", async () => {
    const sizes = await collect(
      paceByBitrate(chunks(100, 200, 300), 10, new AbortController().signal, { realtime: false }),
    );
    expect(sizes).toEqual([100, 200, 300]);
  });

  test("truncates at maxBytes, cutting the last chunk", async () => {
    const sizes = await collect(
      paceByBitrate(chunks(100, 100, 100), 1_000_000, new AbortController().signal, {
        realtime: true,
        maxBytes: 250,
      }),
    );
    expect(sizes).toEqual([100, 100, 50]);
  });

  test("allows an initial burst without sleeping", async () => {
    const started = Date.now();
    await collect(
      paceByBitrate(chunks(1_000, 1_000), 1_000, new AbortController().signal, { realtime: true }),
    );
    expect(Date.now() - started).toBeLessThan(500);
  });

  test("throttles once the burst allowance is exceeded", async () => {
    const started = Date.now();
    await collect(
      paceByBitrate(chunks(5_000, 1_000), 1_000, new AbortController().signal, { realtime: true }),
    );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThan(800);
    expect(elapsed).toBeLessThan(3_000);
  });

  test("stops on abort", async () => {
    const abort = new AbortController();
    const got: number[] = [];
    for await (const chunk of paceByBitrate(chunks(10, 10, 10), 1_000_000, abort.signal, { realtime: false })) {
      got.push(chunk.length);
      abort.abort();
    }
    expect(got).toEqual([10]);
  });
});

describe("primed", () => {
  test("waits for the first item before returning, then yields everything in order", async () => {
    let pulled = 0;
    async function* source() {
      pulled++;
      yield 1;
      pulled++;
      yield 2;
      yield 3;
    }
    const iterable = await primed(source());
    expect(pulled).toBe(1);
    const got: number[] = [];
    for await (const item of iterable) got.push(item);
    expect(got).toEqual([1, 2, 3]);
  });

  test("handles an empty source", async () => {
    async function* empty() {}
    const got: number[] = [];
    for await (const item of await primed(empty())) got.push(item as number);
    expect(got).toEqual([]);
  });
});

function fakeFetch(handler: (range: string, call: number) => Response | Error) {
  const ranges: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const range = new URL(String(input)).searchParams.get("range")!;
    ranges.push(range);
    const result = handler(range, ranges.length);
    if (result instanceof Error) throw result;
    return result;
  }) as typeof fetch;
  return { fn, ranges };
}

const body = (range: string) => {
  const [start, end] = range.split("-").map(Number) as [number, number];
  return new Response(new Uint8Array(end - start + 1));
};

async function drain(iterable: AsyncIterable<Uint8Array>) {
  let total = 0;
  for await (const chunk of iterable) total += chunk.length;
  return total;
}

describe("downloadInRanges", () => {
  const url = "https://example.invalid/audio?x=1";

  test("requests consecutive non-overlapping ranges up to the content length", async () => {
    const { fn, ranges } = fakeFetch((range) => body(range));
    const total = await drain(
      downloadInRanges({ url, userAgent: "test", contentLength: 2_500, chunkBytes: 1_000, fetchFn: fn, signal: new AbortController().signal }),
    );
    expect(ranges).toEqual(["0-999", "1000-1999", "2000-2499"]);
    expect(total).toBe(2_500);
  });

  test("never requests beyond maxBytes", async () => {
    const { fn, ranges } = fakeFetch((range) => body(range));
    const total = await drain(
      downloadInRanges({ url, userAgent: "test", contentLength: 10_000, maxBytes: 1_500, chunkBytes: 1_000, fetchFn: fn, signal: new AbortController().signal }),
    );
    expect(ranges).toEqual(["0-999", "1000-1499"]);
    expect(total).toBe(1_500);
  });

  test("retries a failed range and then continues", async () => {
    const { fn, ranges } = fakeFetch((range, call) =>
      call === 2 ? new Response("denied", { status: 403 }) : body(range),
    );
    const total = await drain(
      downloadInRanges({ url, userAgent: "test", contentLength: 2_000, chunkBytes: 1_000, fetchFn: fn, retryBaseMs: 1, signal: new AbortController().signal }),
    );
    expect(ranges).toEqual(["0-999", "1000-1999", "1000-1999"]);
    expect(total).toBe(2_000);
  });

  test("gives up with a DownloadError after the retries are exhausted", async () => {
    const { fn, ranges } = fakeFetch(() => new Response("denied", { status: 403 }));
    await expect(
      drain(downloadInRanges({ url, userAgent: "test", contentLength: 1_000, chunkBytes: 1_000, fetchFn: fn, retries: 2, retryBaseMs: 1, signal: new AbortController().signal })),
    ).rejects.toBeInstanceOf(DownloadError);
    expect(ranges.length).toBe(3);
  });

  test("stops without error when aborted", async () => {
    const abort = new AbortController();
    const { fn, ranges } = fakeFetch((range) => body(range));
    const got: number[] = [];
    for await (const chunk of downloadInRanges({ url, userAgent: "test", contentLength: 5_000, chunkBytes: 1_000, fetchFn: fn, signal: abort.signal })) {
      got.push(chunk.length);
      abort.abort();
    }
    expect(got).toEqual([1_000]);
    expect(ranges).toEqual(["0-999"]);
  });
});
