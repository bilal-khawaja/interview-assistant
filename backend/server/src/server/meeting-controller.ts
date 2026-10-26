import type { SQL as BunSQL } from "bun";
import type { ChatHost } from "../chat/host";
import type { ChatRunner } from "../chat/runner";
import type { ChatRepository, MeetingRepository } from "../db/repositories/meeting.repository";
import type { SegmentRepository } from "../db/repositories/segment.repository";
import type { Meeting } from "../db/schema";
import { LIVE_RETRY, SegmentAppender, type AppenderDeps } from "../log/append";
import type { DeepgramOptions } from "../producer/deepgram";
import { LiveAudioSource } from "../producer/live-audio";
import { appendFromSource } from "../producer/run";
import type { TranscriptSource } from "../producer/source";

export const MEETING_SOURCES = ["youtube", "live"] as const;
export type MeetingSourceKind = (typeof MEETING_SOURCES)[number];

export type MeetingStartRequest =
  | { source: "youtube"; url: string; title?: string; maxSeconds?: number; realtime?: boolean }
  | { source: "live"; title?: string };

export class MeetingAlreadyLiveError extends Error {
  constructor(readonly meetingId: string) {
    super(`meeting ${meetingId} is already live`);
    this.name = "MeetingAlreadyLiveError";
  }
}

/** The request cannot be served: a bad URL, or no transcription key configured. */
export class MeetingRequestError extends Error {
  constructor(
    message: string,
    readonly kind: "invalid" | "unavailable",
  ) {
    super(message);
    this.name = "MeetingRequestError";
  }
}

export type YoutubeSourceOptions = {
  url: string;
  deepgram: DeepgramOptions;
  baseMs: number;
  maxSeconds?: number;
  realtime?: boolean;
};

export type MeetingControllerDeps = {
  sql: BunSQL;
  meetings: Pick<
    MeetingRepository,
    "create" | "findById" | "setStatus" | "touchHeartbeat" | "list"
  >;
  segments: SegmentRepository;
  chats: Pick<ChatRepository, "create">;
  runner: Pick<ChatRunner, "open">;
  host: Pick<ChatHost, "start">;
  /** Without a key no meeting can be started: both sources transcribe through Deepgram. */
  deepgramApiKey?: string;
  spoolDir?: string;
  /** End a live-audio meeting after this long without audio from the client. */
  liveIdleTimeoutMs?: number;
  /** How long end() waits for the producer to drain before returning. */
  endTimeoutMs?: number;
  /** Replaceable so tests need neither YouTube nor Deepgram. */
  createYoutubeSource?: (options: YoutubeSourceOptions) => Promise<TranscriptSource>;
  createLiveSource?: (deepgram: DeepgramOptions, idleTimeoutMs: number) => LiveAudioSource;
  appender?: Partial<AppenderDeps>;
  log?: (message: string, error?: unknown) => void;
};

type Active = {
  meetingId: string;
  source: MeetingSourceKind;
  abort: AbortController;
  done: Promise<void>;
  live: LiveAudioSource | null;
};

const DEFAULT_END_TIMEOUT_MS = 15_000;
const DEFAULT_LIVE_IDLE_MS = 2 * 60_000;

/**
 * Runs the producer and the chat consumer for a meeting inside the server, so a client
 * starts and ends a meeting with one call. One meeting is live at a time: the microphone
 * is a single source and two producers would only compete for it.
 */
export class MeetingController {
  private active: Active | null = null;
  private starting = false;

  constructor(private readonly deps: MeetingControllerDeps) {}

  get activeMeetingId(): string | null {
    return this.active?.meetingId ?? null;
  }

  /** What a running meeting transcribes, or null for one that is not running here. */
  sourceOf(meetingId: string): MeetingSourceKind | null {
    return this.active?.meetingId === meetingId ? this.active.source : null;
  }

  /** The audio input of the running live meeting, or null. */
  audioInput(meetingId: string): LiveAudioSource | null {
    return this.active?.meetingId === meetingId ? this.active.live : null;
  }

  list(limit?: number): Promise<Meeting[]> {
    return this.deps.meetings.list(limit);
  }

  get(id: string): Promise<Meeting | null> {
    return this.deps.meetings.findById(id);
  }

  async start(request: MeetingStartRequest): Promise<Meeting> {
    if (this.active || this.starting) throw new MeetingAlreadyLiveError(this.active?.meetingId ?? "");
    this.starting = true;
    try {
      return await this.startMeeting(request);
    } finally {
      this.starting = false;
    }
  }

  /**
   * Stops the producer, waits for queued segments to reach the database and marks the
   * meeting ended. Safe to repeat; returns null only when the meeting does not exist.
   */
  async end(meetingId: string): Promise<Meeting | null> {
    const active = this.active?.meetingId === meetingId ? this.active : null;
    if (active) {
      active.abort.abort();
      active.live?.end();
      await Promise.race([
        active.done,
        Bun.sleep(this.deps.endTimeoutMs ?? DEFAULT_END_TIMEOUT_MS),
      ]);
      return this.deps.meetings.findById(meetingId);
    }
    const meeting = await this.deps.meetings.findById(meetingId);
    if (!meeting) return null;
    if (meeting.status === "ended") return meeting;
    return (await this.deps.meetings.setStatus(meetingId, "ended")) ?? meeting;
  }

  /** Ends the running meeting, if any. For server shutdown. */
  async shutdown(): Promise<void> {
    if (this.active) await this.end(this.active.meetingId);
  }

  private async startMeeting(request: MeetingStartRequest): Promise<Meeting> {
    const { deepgramApiKey } = this.deps;
    if (!deepgramApiKey) {
      throw new MeetingRequestError("DEEPGRAM_API_KEY is not set on the server", "unavailable");
    }
    if (request.source === "youtube") {
      const { parseVideoId } = await import("../producer/youtube");
      try {
        parseVideoId(request.url);
      } catch (error) {
        throw new MeetingRequestError(
          error instanceof Error ? error.message : "invalid YouTube URL",
          "invalid",
        );
      }
    }

    const title = request.title?.trim() || (request.source === "live" ? "Live meeting" : request.url);
    const meeting = await this.deps.meetings.create(title);
    let appender: SegmentAppender | null = null;
    try {
      appender = await SegmentAppender.open(this.appenderDeps(), meeting.id);
      await this.deps.meetings.setStatus(meeting.id, "live");

      const deepgram: DeepgramOptions = {
        apiKey: deepgramApiKey,
        onWarn: (message) => this.log(`DEEPGRAM ${message}`),
      };
      let source: TranscriptSource;
      let live: LiveAudioSource | null = null;
      if (request.source === "live") {
        const idle = this.deps.liveIdleTimeoutMs ?? DEFAULT_LIVE_IDLE_MS;
        live = this.deps.createLiveSource
          ? this.deps.createLiveSource(deepgram, idle)
          : new LiveAudioSource({
              deepgram,
              baseMs: 0,
              idleTimeoutMs: idle,
              onDrop: (bytes) => this.log(`LIVE audio backlog full, dropped ${bytes} bytes`),
            });
        source = live;
      } else {
        const options: YoutubeSourceOptions = {
          url: request.url,
          deepgram,
          baseMs: 0,
          maxSeconds: request.maxSeconds ?? 300,
          realtime: request.realtime,
        };
        source = await (this.deps.createYoutubeSource ?? defaultYoutubeSource)(options);
      }

      const chat = await this.deps.chats.create(meeting.id, title);
      await this.deps.runner.open(chat.id);
      this.deps.host.start(meeting.id, chat.id);

      const abort = new AbortController();
      this.active = {
        meetingId: meeting.id,
        source: request.source,
        abort,
        live,
        done: this.run(meeting.id, source, appender, abort),
      };
    } catch (error) {
      await appender?.close().catch(() => undefined);
      await this.deps.meetings.setStatus(meeting.id, "ended").catch(() => undefined);
      throw error;
    }
    return (await this.deps.meetings.findById(meeting.id)) ?? meeting;
  }

  private async run(
    meetingId: string,
    source: TranscriptSource,
    appender: SegmentAppender,
    abort: AbortController,
  ): Promise<void> {
    try {
      const appended = await appendFromSource(source, appender, abort.signal, {
        whenFull: "drop",
        onDrop: ({ count, startMs, endMs }) =>
          this.log(`BACKLOG FULL dropped ${count} segment(s) ${startMs}-${endMs}ms, recorded as a gap`),
      });
      this.log(`MEETING ${meetingId} source finished, appended=${appended}`);
    } catch (error) {
      this.log(`MEETING ${meetingId} producer failed`, error);
    } finally {
      await appender.close().catch((error) => this.log(`MEETING ${meetingId} close failed`, error));
      await this.deps.meetings
        .setStatus(meetingId, "ended")
        .catch((error) => this.log(`MEETING ${meetingId} could not be marked ended`, error));
      if (this.active?.meetingId === meetingId) this.active = null;
    }
  }

  private appenderDeps(): AppenderDeps {
    const { meetings } = this.deps;
    return {
      sql: this.deps.sql,
      segments: this.deps.segments,
      ...LIVE_RETRY,
      spoolDir: this.deps.spoolDir,
      onSpoolError: (error) => this.log("SPOOL write failed, rows are only in memory", error),
      onHeartbeat: (id) => meetings.touchHeartbeat(id),
      readMeetingStatus: async (id) => (await meetings.findById(id))?.status ?? null,
      onReattach: async (id) => {
        await meetings.setStatus(id, "live");
      },
      onHealth: ({ state, pending, error }) =>
        this.log(
          state === "degraded"
            ? `DB unreachable, buffering ${pending} segment(s): ${error instanceof Error ? error.message : error}`
            : `DB back, buffered segments are written (${pending} still pending)`,
        ),
      ...this.deps.appender,
    };
  }

  private log(message: string, error?: unknown): void {
    if (this.deps.log) this.deps.log(message, error);
    else if (error) console.error(`SERVER ${message}`, error);
    else console.log(`SERVER ${message}`);
  }
}

async function defaultYoutubeSource(options: YoutubeSourceOptions): Promise<TranscriptSource> {
  const { YoutubeDeepgramSource } = await import("../producer/youtube");
  return new YoutubeDeepgramSource(options);
}
