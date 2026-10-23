import { Innertube } from "youtubei.js";
import { transcribeAudio, type DeepgramOptions } from "./deepgram";
import type { SourceSegment, TranscriptSource } from "./source";

export type YoutubeOptions = {
  url: string;
  deepgram: DeepgramOptions;
  baseMs: number;
  maxSeconds?: number;
  realtime?: boolean;
};

const BURST_SECONDS = 5;
const CHUNK_BYTES = 1_000_000;

type ClientProfile = { name: "VISIONOS" | "IOS"; userAgent: string };

const CLIENT_PROFILES: readonly ClientProfile[] = [
  {
    name: "VISIONOS",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  },
  {
    name: "IOS",
    userAgent: "com.google.ios.youtube/20.11.6 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X;)",
  },
];

export class InvalidYoutubeUrlError extends Error {
  constructor(input: string) {
    super(`could not find a YouTube video id in "${input}"`);
    this.name = "InvalidYoutubeUrlError";
  }
}

export function parseVideoId(input: string): string {
  if (/^[\w-]{11}$/.test(input)) return input;
  try {
    const url = new URL(input);
    const host = url.hostname.replace(/^www\.|^m\./, "");
    if (host === "youtu.be") {
      const id = url.pathname.split("/")[1];
      if (id && /^[\w-]{11}$/.test(id)) return id;
    }
    if (host === "youtube.com" || host === "music.youtube.com") {
      const fromQuery = url.searchParams.get("v");
      if (fromQuery && /^[\w-]{11}$/.test(fromQuery)) return fromQuery;
      const [, kind, id] = url.pathname.split("/");
      if (kind && ["shorts", "live", "embed", "v"].includes(kind) && id && /^[\w-]{11}$/.test(id)) {
        return id;
      }
    }
  } catch {
    throw new InvalidYoutubeUrlError(input);
  }
  throw new InvalidYoutubeUrlError(input);
}

export type RangeDownloadOptions = {
  url: string;
  userAgent: string;
  contentLength: number;
  signal: AbortSignal;
  fetchFn?: typeof fetch;
  chunkBytes?: number;
  maxBytes?: number;
  retries?: number;
  retryBaseMs?: number;
};

export class DownloadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DownloadError";
  }
}

export async function* downloadInRanges(
  options: RangeDownloadOptions,
): AsyncGenerator<Uint8Array> {
  const fetchFn = options.fetchFn ?? fetch;
  const chunkBytes = options.chunkBytes ?? CHUNK_BYTES;
  const retries = options.retries ?? 3;
  const retryBaseMs = options.retryBaseMs ?? 250;
  const total = Math.min(options.contentLength, options.maxBytes ?? options.contentLength);

  for (let start = 0; start < total; start += chunkBytes) {
    if (options.signal.aborted) return;
    const end = Math.min(start + chunkBytes, total) - 1;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetchFn(`${options.url}&range=${start}-${end}`, {
          headers: { "User-Agent": options.userAgent },
          signal: options.signal,
        });
        if (!response.ok) throw new DownloadError(`range ${start}-${end} returned ${response.status}`);
        yield new Uint8Array(await response.arrayBuffer());
        lastError = undefined;
        break;
      } catch (error) {
        if (options.signal.aborted) return;
        lastError = error;
        if (attempt < retries) await sleep(retryBaseMs * 2 ** attempt, options.signal);
      }
    }
    if (lastError !== undefined) {
      throw new DownloadError(`could not download bytes ${start}-${end}`, { cause: lastError });
    }
  }
}

export async function* paceByBitrate(
  chunks: AsyncIterable<Uint8Array>,
  bytesPerSecond: number,
  signal: AbortSignal,
  options: { realtime: boolean; maxBytes?: number },
): AsyncGenerator<Uint8Array> {
  const startedAt = Date.now();
  let sent = 0;
  for await (const chunk of chunks) {
    if (signal.aborted) return;
    let piece = chunk;
    if (options.maxBytes !== undefined) {
      const remaining = options.maxBytes - sent;
      if (remaining <= 0) return;
      if (piece.length > remaining) piece = piece.subarray(0, remaining);
    }
    sent += piece.length;

    if (options.realtime) {
      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      const allowed = (elapsedSeconds + BURST_SECONDS) * bytesPerSecond;
      if (sent > allowed) {
        await sleep(((sent - allowed) / bytesPerSecond) * 1000, signal);
      }
    }
    yield piece;
    if (options.maxBytes !== undefined && sent >= options.maxBytes) return;
  }
}

export async function primed<T>(source: AsyncIterable<T>): Promise<AsyncGenerator<T>> {
  const iterator = source[Symbol.asyncIterator]();
  const first = await iterator.next();
  return (async function* () {
    try {
      if (first.done) return;
      yield first.value;
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      await iterator.return?.();
    }
  })();
}

type ResolvedAudio = {
  url: string;
  contentLength: number;
  bytesPerSecond: number;
  userAgent: string;
};

async function resolveAudio(
  youtube: Innertube,
  videoId: string,
  profile: ClientProfile,
): Promise<ResolvedAudio> {
  const info = await youtube.getBasicInfo(videoId, { client: profile.name });
  if (info.basic_info.is_live) {
    throw new Error("live streams are not supported; use a regular video");
  }
  const format = info.chooseFormat({ type: "audio", quality: "best" });
  if (!format.content_length) throw new DownloadError("audio format has no content length");
  return {
    url: await format.decipher(youtube.session.player),
    contentLength: format.content_length,
    bytesPerSecond: Math.max(1, Math.round((format.bitrate ?? 128_000) / 8)),
    userAgent: profile.userAgent,
  };
}

export class YoutubeDeepgramSource implements TranscriptSource {
  constructor(private readonly options: YoutubeOptions) {}

  async *stream(signal: AbortSignal): AsyncGenerator<SourceSegment> {
    const videoId = parseVideoId(this.options.url);
    const youtube = await Innertube.create({ retrieve_player: true });

    let resolved: ResolvedAudio | undefined;
    let lastError: unknown;
    for (const profile of CLIENT_PROFILES) {
      try {
        resolved = await resolveAudio(youtube, videoId, profile);
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!resolved) {
      throw new DownloadError("could not get an audio stream for this video", { cause: lastError });
    }

    const { url, contentLength, bytesPerSecond, userAgent } = resolved;
    const maxBytes = this.options.maxSeconds
      ? this.options.maxSeconds * bytesPerSecond
      : undefined;

    const chunks = paceByBitrate(
      downloadInRanges({
        url,
        userAgent,
        contentLength,
        signal,
        maxBytes,
      }),
      bytesPerSecond,
      signal,
      { realtime: this.options.realtime !== false, maxBytes },
    );

    yield* transcribeAudio(
      { ...this.options.deepgram, bytesPerSecond },
      await primed(chunks),
      signal,
      this.options.baseMs,
    );
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
