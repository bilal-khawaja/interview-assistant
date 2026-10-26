import { abortableSleep, backoffMs } from "../retry";
import { AsyncQueue, QueueOverflowError } from "./async-queue";
import { Fmp4Tracker, type Fragment } from "./mp4";
import type { SourceSegment } from "./source";

export type ReconnectPolicy = {
  maxAttempts: number;
  baseMs: number;
  maxMs: number;
};

export type SocketFactory = (url: string, protocols: string[]) => WebSocket;

export type DeepgramOptions = {
  apiKey: string;
  model?: string;
  language?: string;
  /**
   * Headerless PCM input (e.g. a microphone). Without it Deepgram detects a container, which a
   * reconnect cannot resume mid-stream. Set bytesPerSecond to sampleRate * 2 * channels too.
   */
  pcm?: { sampleRate: number; channels?: number };
  diarize?: boolean;
  reconnect?: Partial<ReconnectPolicy>;
  maxBuffered?: number;
  flushTimeoutMs?: number;
  connect?: SocketFactory;
  /** Told about messages that could not be read. Defaults to ignoring them. */
  onWarn?: (message: string) => void;
  /** This many unreadable messages in a row fail the stream: the protocol has probably changed. */
  maxUnreadable?: number;
  /**
   * Audio bitrate in bytes per second. With it, a gap is the audio sent but never
   * transcribed, measured on the audio timeline, so it stays right when the source runs
   * faster than real time. Without it the gap is wall-clock time.
   */
  bytesPerSecond?: number;
  /**
   * Most audio, in ms, kept to resend after a reconnect. Needs bytesPerSecond. Audio drops
   * out of the buffer once it is transcribed, so this only caps how far Deepgram may fall
   * behind a fast source before the oldest untranscribed audio becomes a gap. Default 2 min;
   * 0 turns it off.
   */
  replayBufferMs?: number;
};

const OPEN = 1;
const DEFAULT_RECONNECT: ReconnectPolicy = { maxAttempts: 5, baseMs: 500, maxMs: 10_000 };
const DEFAULT_MAX_BUFFERED = 500;
const DEFAULT_FLUSH_MS = 3_000;
const BACKPRESSURE_POLL_MS = 50;
const DEFAULT_MAX_UNREADABLE = 20;
const DEFAULT_REPLAY_BUFFER_MS = 120_000;
const PIECE_MS = 500;
const NOT_BEFORE_SLACK_MS = 20;

export class UnreadableStreamError extends Error {
  constructor(readonly count: number) {
    super(`deepgram sent ${count} unreadable messages in a row`);
    this.name = "UnreadableStreamError";
  }
}

type DeepgramWord = {
  speaker?: number;
  word?: string;
  punctuated_word?: string;
  start?: number;
  end?: number;
};

type DeepgramResults = {
  type?: string;
  is_final?: boolean;
  start?: number;
  duration?: number;
  channel?: {
    alternatives?: { transcript?: string; words?: DeepgramWord[] }[];
  };
};

export function deepgramUrl(options: DeepgramOptions): string {
  const params = new URLSearchParams({
    model: options.model ?? "nova-3",
    language: options.language ?? "en",
    diarize: String(options.diarize ?? true),
    smart_format: "true",
    interim_results: "false",
  });
  if (options.pcm) {
    params.set("encoding", "linear16");
    params.set("sample_rate", String(options.pcm.sampleRate));
    params.set("channels", String(options.pcm.channels ?? 1));
  }
  return `${process.env.DEEPGRAM_WS_URL?.trim() || "wss://api.deepgram.com/v1/listen"}?${params}`;
}

/**
 * Turns a final result into segments. A result where the speaker changes mid-utterance is
 * split at each change, so one segment never mixes two voices. Words need text and timing to
 * be split; without them the result stays one segment labelled with its dominant speaker.
 * With notBeforeMs, words that started before it are dropped: they repeat text already
 * stored, which happens when audio is resent from the start of a fragment.
 */
export function parseDeepgramMessage(
  message: unknown,
  baseMs: number,
  notBeforeMs?: number,
): SourceSegment[] {
  const result = message as DeepgramResults;
  if (result?.type !== "Results" || !result.is_final) return [];

  const alternative = result.channel?.alternatives?.[0];
  const text = alternative?.transcript?.trim();
  if (!text) return [];

  const words = alternative?.words ?? [];
  if (notBeforeMs !== undefined && words.length > 0 && words.every((w) => typeof w.start === "number")) {
    const kept = words.filter((word) => baseMs + (word.start ?? 0) * 1000 >= notBeforeMs - NOT_BEFORE_SLACK_MS);
    if (kept.length < words.length) {
      if (kept.length === 0) return [];
      const trimmed = splitBySpeaker(kept, baseMs, true);
      if (trimmed) return trimmed;
    }
  }
  const split = splitBySpeaker(words, baseMs);
  if (split) return split;

  const startMs = baseMs + Math.round((result.start ?? 0) * 1000);
  const endMs = startMs + Math.round((result.duration ?? 0) * 1000);
  if (notBeforeMs !== undefined && endMs <= notBeforeMs) return [];
  const speaker = dominantSpeaker(words);
  return [
    {
      text,
      startMs,
      endMs,
      speakerKey: speaker === null ? null : `spk_${speaker}`,
      source: "deepgram",
    },
  ];
}

function splitBySpeaker(
  words: DeepgramWord[],
  baseMs: number,
  always = false,
): SourceSegment[] | null {
  type Run = { speaker: number | null; words: string[]; start: number; end: number };
  const runs: Run[] = [];
  for (const word of words) {
    const text = (word.punctuated_word ?? word.word)?.trim();
    if (!text || typeof word.start !== "number" || typeof word.end !== "number") return null;
    const speaker = typeof word.speaker === "number" ? word.speaker : null;
    const last = runs.at(-1);
    // A word with no speaker label belongs to the run it sits in.
    if (last && (speaker === null || last.speaker === null || last.speaker === speaker)) {
      last.speaker ??= speaker;
      last.words.push(text);
      last.end = word.end;
    } else {
      runs.push({ speaker, words: [text], start: word.start, end: word.end });
    }
  }
  if (runs.length === 0 || (runs.length < 2 && !always)) return null;
  return runs.map((run) => {
    const startMs = baseMs + Math.round(run.start * 1000);
    return {
      text: run.words.join(" "),
      startMs,
      endMs: Math.max(startMs, baseMs + Math.round(run.end * 1000)),
      speakerKey: run.speaker === null ? null : `spk_${run.speaker}`,
      source: "deepgram",
    };
  });
}

function dominantSpeaker(words: DeepgramWord[]): number | null {
  const counts = new Map<number, number>();
  for (const word of words) {
    if (typeof word.speaker !== "number") continue;
    counts.set(word.speaker, (counts.get(word.speaker) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [speaker, count] of counts) {
    if (count > bestCount) {
      best = speaker;
      bestCount = count;
    }
  }
  return best;
}

export function isCleanClose(code: number, closeRequested: boolean): boolean {
  return closeRequested || code === 1000 || code === 1005;
}

type Session = {
  socket: WebSocket;
  queue: AsyncQueue<SourceSegment>;
  closeRequested: boolean;
  baseMs: number;
  lastMessageAt: number;
  yielded: boolean;
  /** Set when audio was resent to this session; guards against re-emitting old text. */
  replayed?: boolean;
  /** Words that started before this are repeats of text already stored. */
  notBeforeMs?: number;
  keepAlive?: ReturnType<typeof setInterval>;
};

async function openSession(
  options: DeepgramOptions,
  connect: SocketFactory,
  maxBuffered: number,
): Promise<Session> {
  const queue = new AsyncQueue<SourceSegment>(maxBuffered);
  const socket = connect(deepgramUrl(options), ["token", options.apiKey]);
  const session: Session = {
    socket,
    queue,
    closeRequested: false,
    baseMs: 0,
    lastMessageAt: Date.now(),
    yielded: false,
  };

  try {
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("deepgram connection failed"));
      socket.onclose = (event) =>
        reject(new Error(`deepgram closed ${event.code} ${event.reason}`));
    });
  } catch (error) {
    closeQuietly(socket);
    throw error;
  }

  socket.onerror = () => undefined;
  let unreadable = 0;
  const maxUnreadable = options.maxUnreadable ?? DEFAULT_MAX_UNREADABLE;
  socket.onmessage = (event) => {
    session.lastMessageAt = Date.now();
    try {
      const segments = parseDeepgramMessage(
        JSON.parse(String(event.data)),
        session.baseMs,
        session.notBeforeMs,
      );
      unreadable = 0;
      for (const segment of segments) queue.push(segment);
    } catch (error) {
      unreadable++;
      const sample = String(event.data).slice(0, 120);
      options.onWarn?.(
        `deepgram message could not be read (${unreadable} in a row): ${error instanceof Error ? error.message : error}; got ${JSON.stringify(sample)}`,
      );
      if (unreadable >= maxUnreadable) {
        queue.close(new UnreadableStreamError(unreadable));
        closeQuietly(socket);
      }
    }
  };
  socket.onclose = (event) => {
    queue.close(
      isCleanClose(event.code, session.closeRequested)
        ? undefined
        : new Error(`deepgram closed ${event.code} ${event.reason}`),
    );
  };
  session.keepAlive = setInterval(() => {
    if (socket.readyState === OPEN) {
      socket.send(JSON.stringify({ type: "KeepAlive" }));
    }
  }, 8_000);
  return session;
}

function closeQuietly(socket: WebSocket): void {
  try {
    socket.close(1000);
  } catch {
    return;
  }
}

function endSession(session: Session): void {
  clearInterval(session.keepAlive);
  closeQuietly(session.socket);
}

function requestClose(session: Session): void {
  if (session.closeRequested || session.socket.readyState !== OPEN) return;
  try {
    session.socket.send(JSON.stringify({ type: "CloseStream" }));
    session.closeRequested = true;
  } catch {
    return;
  }
}

/**
 * Streams audio to Deepgram and yields final segments. A dropped connection is
 * re-opened with backoff and the audio iterator keeps its place, so no chunk is
 * lost. With options.bytesPerSecond the audio sent but not yet transcribed is also kept (up
 * to replayBufferMs), and after a reconnect it is sent again. Whatever the buffer no
 * longer holds, or the whole outage when the bitrate is unknown, is reported as a segment
 * with source "gap" and empty text. Aborting sends CloseStream and waits up to
 * flushTimeoutMs for Deepgram to flush the last utterance. If the consumer
 * falls behind, the audio pump pauses at half of maxBuffered; the stream fails
 * with QueueOverflowError if the backlog still reaches maxBuffered.
 */
export async function* transcribeAudio(
  options: DeepgramOptions,
  audio: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  baseMs: number,
): AsyncGenerator<SourceSegment> {
  const connect = options.connect ?? ((url, protocols) => new WebSocket(url, protocols));
  const policy = { ...DEFAULT_RECONNECT, ...options.reconnect };
  const maxBuffered = options.maxBuffered ?? DEFAULT_MAX_BUFFERED;
  const flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_FLUSH_MS;
  const highWater = Math.max(1, Math.floor(maxBuffered / 2));
  const iterator = audio[Symbol.asyncIterator]();

  let current: Session | null = null;
  let audioDone = false;
  let stop = false;
  let pumpError: unknown = null;
  let pump: Promise<void> | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let notify: (() => void) | null = null;

  const poke = () => {
    const wake = notify;
    notify = null;
    wake?.();
  };
  const changed = () => new Promise<void>((resolve) => (notify = resolve));

  const onAbort = () => {
    stop = true;
    const session = current;
    if (session) {
      requestClose(session);
      flushTimer = setTimeout(() => closeQuietly(session.socket), flushTimeoutMs);
    }
    poke();
  };
  signal.addEventListener("abort", onAbort, { once: true });

  // Sources hand over large chunks (a YouTube range is about a minute of audio). Send and
  // remember small pieces instead, so a reconnect can resend from close to the right spot.
  const pieceBytes =
    options.bytesPerSecond && options.bytesPerSecond > 0
      ? Math.max(1, Math.floor(options.bytesPerSecond * (PIECE_MS / 1000)))
      : Infinity;
  function* pieces(chunk: Uint8Array): Generator<Uint8Array> {
    for (let at = 0; at < chunk.length; at += pieceBytes) {
      yield chunk.subarray(at, at + pieceBytes);
    }
    if (chunk.length === 0) yield chunk;
  }

  const startPump = () =>
    (async () => {
      try {
        for (;;) {
          if (stop) return;
          const next = await iterator.next();
          if (next.done) {
            audioDone = true;
            if (current) requestClose(current);
            poke();
            return;
          }
          for (const piece of pieces(next.value)) {
            for (;;) {
              if (stop) return;
              const session = current;
              if (session && session.socket.readyState === OPEN) {
                if (session.queue.size >= highWater) {
                  await abortableSleep(BACKPRESSURE_POLL_MS, signal);
                  continue;
                }
                sendPiece(session, piece);
                break;
              }
              await changed();
            }
          }
        }
      } catch (error) {
        pumpError = error;
        current?.queue.close(error);
      }
    })();

  let bytesSent = 0;
  const bytesPerSecond =
    options.bytesPerSecond && options.bytesPerSecond > 0 ? options.bytesPerSecond : null;
  // A fragmented MP4 is followed box by box, so a new connection can be given the init
  // segment and whole fragments instead of an arbitrary byte range, which cannot be decoded.
  const tracker = new Fmp4Tracker();
  const mp4 = () => tracker.active === true;
  const msAt = (audioBytes: number) =>
    baseMs + Math.round((audioBytes * 1000) / (bytesPerSecond ?? 1));
  const audioPositionMs = () =>
    bytesPerSecond === null ? null : msAt(mp4() ? tracker.mediaBytes : bytesSent);

  // Audio sent but not yet transcribed, kept for resending after a reconnect, tagged with
  // where it sits on the audio timeline. Needs the bitrate to know each piece's duration.
  type SentChunk = { data: Uint8Array; startMs: number; endMs: number };
  const replayWindowMs = options.replayBufferMs ?? DEFAULT_REPLAY_BUFFER_MS;
  const recent: SentChunk[] = [];
  const keepRecent = (chunk: SentChunk) => {
    recent.push(chunk);
    while (recent.length > 1 && recent[0]!.endMs < chunk.endMs - replayWindowMs) recent.shift();
    while (recent.length > 0 && recent[0]!.endMs <= lastEndMs) recent.shift();
  };
  const rememberBytes = (data: Uint8Array) => {
    const startMs = audioPositionMs();
    bytesSent += data.length;
    const endMs = audioPositionMs();
    if (startMs === null || endMs === null || replayWindowMs <= 0) return;
    keepRecent({ data, startMs, endMs });
  };
  const rememberFragment = (fragment: Fragment) => {
    if (bytesPerSecond === null || replayWindowMs <= 0) return;
    keepRecent({
      data: fragment.data,
      startMs: msAt(fragment.startMedia),
      endMs: msAt(fragment.endMedia),
    });
  };
  // Parsing and sending happen together, with nothing awaited between them, so the tracker
  // always describes exactly what the current session has been sent.
  const sendPiece = (session: Session, piece: Uint8Array) => {
    const out = tracker.push(piece);
    if (out.forward.length > 0) session.socket.send(out.forward as Uint8Array<ArrayBuffer>);
    if (mp4()) for (const fragment of out.fragments) rememberFragment(fragment);
    else rememberBytes(out.forward);
  };

  let lastEndMs = baseMs;
  let lastAliveAt = Date.now();
  let connectedBefore = false;
  let failures = 0;

  try {
    while (!stop) {
      let session: Session;
      try {
        session = await openSession(options, connect, maxBuffered);
      } catch (error) {
        if (stop) return;
        if (++failures > policy.maxAttempts) throw error;
        await abortableSleep(backoffMs(failures, policy.baseMs, policy.maxMs), signal);
        continue;
      }
      if (stop) {
        endSession(session);
        return;
      }

      session.baseMs = lastEndMs;
      let replay: Uint8Array[] = [];
      if (connectedBefore) {
        const audioEnd = audioPositionMs();
        const previousEndMs = lastEndMs;
        let gapEnd: number;
        if (audioEnd === null) {
          gapEnd = lastEndMs + Math.max(0, Date.now() - lastAliveAt);
          session.baseMs = gapEnd;
          // Without a bitrate there is no buffer, but the new connection still needs the
          // init segment and the start of the fragment that was arriving.
          if (mp4()) replay = [tracker.initBytes(), tracker.partial()?.data ?? new Uint8Array(0)];
        } else if (mp4()) {
          // Init segment, then every fragment not yet fully transcribed, then the fragment
          // that was arriving. Fragments are whole so Deepgram can decode them; words from
          // before the last transcript are dropped from what comes back.
          const fragments = recent.filter((chunk) => chunk.endMs > lastEndMs);
          const partial = tracker.partial();
          const resumeAt = fragments[0]?.startMs ?? (partial ? msAt(partial.startMedia) : audioEnd);
          replay = [
            tracker.initBytes(),
            ...fragments.map((chunk) => chunk.data),
            ...(partial ? [partial.data] : []),
          ];
          gapEnd = Math.max(lastEndMs, resumeAt);
          session.baseMs = resumeAt;
          session.notBeforeMs = previousEndMs;
        } else {
          // Resend whole chunks after the last transcript, so nothing already transcribed
          // is spoken twice. What the buffer no longer holds is the gap.
          const chunks = recent.filter((chunk) => chunk.startMs >= lastEndMs);
          replay = chunks.map((chunk) => chunk.data);
          gapEnd = Math.max(lastEndMs, chunks[0]?.startMs ?? audioEnd);
          session.baseMs = gapEnd;
        }
        const gap: SourceSegment = {
          text: "",
          startMs: lastEndMs,
          endMs: gapEnd,
          speakerKey: null,
          source: "gap",
        };
        lastEndMs = gapEnd;
        // With known audio timing, a fully replayed outage leaves no gap to report.
        if (audioEnd === null || gapEnd > previousEndMs) yield gap;
        if (stop) {
          endSession(session);
          return;
        }
      }
      connectedBefore = true;
      current = session;
      const resend = replay.filter((data) => data.length > 0);
      if (resend.length > 0) {
        session.replayed = true;
        for (const data of resend) session.socket.send(data as Uint8Array<ArrayBuffer>);
      }
      if (audioDone) requestClose(session);
      pump ??= startPump();
      poke();

      let failure: unknown = null;
      try {
        for await (const segment of session.queue) {
          if (session.replayed && segment.endMs <= lastEndMs) continue;
          session.yielded = true;
          lastEndMs = Math.max(lastEndMs, segment.endMs);
          yield segment;
        }
      } catch (error) {
        failure = error;
      }
      lastAliveAt = session.lastMessageAt;
      current = null;
      endSession(session);
      poke();

      if (pumpError) throw pumpError;
      if (failure instanceof QueueOverflowError || failure instanceof UnreadableStreamError) {
        throw failure;
      }
      if (stop) return;
      if (audioDone) {
        if (failure) throw failure;
        return;
      }

      failures = session.yielded ? 1 : failures + 1;
      if (failures > policy.maxAttempts) {
        throw failure ?? new Error("deepgram closed before the audio ended");
      }
      await abortableSleep(backoffMs(failures, policy.baseMs, policy.maxMs), signal);
    }
  } finally {
    stop = true;
    poke();
    clearTimeout(flushTimer);
    signal.removeEventListener("abort", onAbort);
    if (current) endSession(current);
    await pump?.catch(() => undefined);
    await iterator.return?.().catch(() => undefined);
  }
}
