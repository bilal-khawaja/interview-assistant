import type { SQL as BunSQL } from "bun";
import type { ChatHost } from "../chat/host";
import type { ChatRunner } from "../chat/runner";
import type {
  AccessibleMeeting,
  ChatRepository,
  MeetingRepository,
} from "../db/repositories/meeting.repository";
import type { SegmentRepository } from "../db/repositories/segment.repository";
import type { Meeting } from "../db/schema";
import { LIVE_RETRY, SegmentAppender, type AppenderDeps } from "../log/append";
import type { DeepgramOptions } from "../producer/deepgram";
import { LiveAudioSource } from "../producer/live-audio";
import { MergedSource } from "../producer/merged-source";
import { appendFromSource } from "../producer/run";
import type { TranscriptSource } from "../producer/source";
import { userSpeakerKey } from "./speaker-binder";

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

/** Why a microphone could not be opened for a meeting. */
export type AudioRefusal = "not_found" | "not_live" | "full" | "busy";

export type AudioOpening = { input: LiveAudioSource } | { error: AudioRefusal };

/** Most microphones feeding one meeting, the owner's included. Each one is a Deepgram stream. */
export const DEFAULT_MAX_LIVE_SPEAKERS = 6;

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
    "create" | "findById" | "findOwned" | "findAccessible" | "setStatus" | "touchHeartbeat" | "listAccessible"
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
  /** `baseMs` is how far into the meeting the microphone starts, so late joiners line up. */
  createLiveSource?: (deepgram: DeepgramOptions, idleTimeoutMs: number, baseMs: number) => LiveAudioSource;
  /** Names microphone owners in the transcript. Without it their segments carry a key but no name. */
  speakers?: { bind(meetingId: string, userId: string, role: "host" | "participant"): Promise<void> };
  maxLiveSpeakers?: number;
  appender?: Partial<AppenderDeps>;
  log?: (message: string, error?: unknown) => void;
};

type Active = {
  meetingId: string;
  userId: string;
  source: MeetingSourceKind;
  abort: AbortController;
  done: Promise<void>;
  /** The owner's microphone. */
  live: LiveAudioSource | null;
  /** Everything that feeds a live meeting; null for sources with a single input. */
  merged: MergedSource | null;
  /** Other accounts' microphones by user id. */
  speakers: Map<string, LiveAudioSource>;
  deepgram: DeepgramOptions;
  startedAt: number;
};

const DEFAULT_END_TIMEOUT_MS = 15_000;
const DEFAULT_LIVE_IDLE_MS = 2 * 60_000;

/**
 * Runs the producer and the chat consumer for a meeting inside the server, so a client
 * starts and ends a meeting with one call. Each user has at most one live meeting, since
 * a person has a single microphone; different users run theirs side by side. Every piece
 * of live state (producer, audio input, spool, producer lock) belongs to one meeting, so
 * nothing is shared between users.
 */
export class MeetingController {
  /** Running meetings by meeting id. */
  private readonly running = new Map<string, Active>();
  /** Users whose start is in progress, so two quick starts cannot both pass the check. */
  private readonly starting = new Set<string>();

  constructor(private readonly deps: MeetingControllerDeps) {}

  /** The user's running meeting, or null. */
  activeMeetingId(userId: string): string | null {
    return this.activeOf(userId)?.meetingId ?? null;
  }

  private activeOf(userId: string): Active | null {
    for (const active of this.running.values()) if (active.userId === userId) return active;
    return null;
  }

  /** What a running meeting transcribes, or null for one that is not running here. */
  sourceOf(meetingId: string): MeetingSourceKind | null {
    return this.running.get(meetingId)?.source ?? null;
  }

  /** The owner's audio input of the running live meeting, or null. */
  audioInput(meetingId: string): LiveAudioSource | null {
    return this.running.get(meetingId)?.live ?? null;
  }

  /**
   * The microphone input for a person in a live meeting: the owner's, or, for a member, one
   * opened on first use and kept across reconnects until it goes idle or they leave. A
   * person has one microphone, so one that is open in another meeting is refused.
   */
  async openAudio(userId: string, meetingId: string): Promise<AudioOpening> {
    const meeting = await this.deps.meetings.findAccessible(meetingId, userId);
    if (!meeting) return { error: "not_found" };
    const active = this.running.get(meetingId);
    if (!active?.live || !active.merged) return { error: "not_live" };
    if (meeting.role === "owner") return { input: active.live };

    const existing = active.speakers.get(userId);
    if (existing && !existing.isEnded) return { input: existing };
    const open = [...active.speakers.values()].filter((input) => !input.isEnded).length;
    if (open + 1 >= (this.deps.maxLiveSpeakers ?? DEFAULT_MAX_LIVE_SPEAKERS)) return { error: "full" };
    if (this.micMeeting(userId, meetingId)) return { error: "busy" };

    const input = this.newLiveSource(active.deepgram, Date.now() - active.startedAt);
    if (!active.merged.add(input, userSpeakerKey(userId))) return { error: "not_live" };
    active.speakers.set(userId, input);
    this.bindSpeaker(meetingId, userId, "participant");
    return { input };
  }

  /** Stops taking a member's audio. What was already sent is still transcribed. */
  dropParticipant(meetingId: string, userId: string): void {
    this.running.get(meetingId)?.speakers.get(userId)?.end();
  }

  /** The meeting in which the person's microphone is open, other than `except`, or null. */
  private micMeeting(userId: string, except: string): string | null {
    for (const active of this.running.values()) {
      if (active.meetingId === except) continue;
      if (active.userId === userId && active.live) return active.meetingId;
      const input = active.speakers.get(userId);
      if (input && !input.isEnded) return active.meetingId;
    }
    return null;
  }

  private newLiveSource(deepgram: DeepgramOptions, baseMs: number): LiveAudioSource {
    const idle = this.deps.liveIdleTimeoutMs ?? DEFAULT_LIVE_IDLE_MS;
    return this.deps.createLiveSource
      ? this.deps.createLiveSource(deepgram, idle, baseMs)
      : new LiveAudioSource({
          deepgram,
          baseMs,
          idleTimeoutMs: idle,
          onDrop: (bytes) => this.log(`LIVE audio backlog full, dropped ${bytes} bytes`),
        });
  }

  private bindSpeaker(meetingId: string, userId: string, role: "host" | "participant"): void {
    this.deps.speakers
      ?.bind(meetingId, userId, role)
      .catch((error) => this.log(`SPEAKER bind failed for ${userId}`, error));
  }

  /** The meetings the user owns or has joined. */
  list(userId: string, limit?: number): Promise<AccessibleMeeting[]> {
    return this.deps.meetings.listAccessible(userId, limit);
  }

  /** The meeting if the user owns it or has joined it, else null. */
  get(userId: string, id: string): Promise<AccessibleMeeting | null> {
    return this.deps.meetings.findAccessible(id, userId);
  }

  async start(userId: string, request: MeetingStartRequest): Promise<Meeting> {
    const live = this.activeOf(userId);
    if (live || this.starting.has(userId)) throw new MeetingAlreadyLiveError(live?.meetingId ?? "");
    // One microphone: someone speaking in another person's meeting cannot start their own.
    const speakingIn = this.micMeeting(userId, "");
    if (speakingIn) throw new MeetingAlreadyLiveError(speakingIn);
    this.starting.add(userId);
    try {
      return await this.startMeeting(userId, request);
    } finally {
      this.starting.delete(userId);
    }
  }

  /**
   * Stops the producer, waits for queued segments to reach the database and marks the
   * meeting ended. Safe to repeat; returns null when the meeting does not exist or is not
   * the user's.
   */
  async end(userId: string, meetingId: string): Promise<Meeting | null> {
    if (!(await this.deps.meetings.findOwned(meetingId, userId))) return null;
    return this.stop(meetingId);
  }

  private async stop(meetingId: string): Promise<Meeting | null> {
    const active = this.running.get(meetingId) ?? null;
    if (active) {
      active.abort.abort();
      active.live?.end();
      for (const input of active.speakers.values()) input.end();
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

  /** Ends every running meeting. For server shutdown. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.running.keys()].map((meetingId) => this.stop(meetingId)));
  }

  private async startMeeting(userId: string, request: MeetingStartRequest): Promise<Meeting> {
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

    const startedAt = Date.now();
    const title = request.title?.trim() || (request.source === "live" ? "Live meeting" : request.url);
    const meeting = await this.deps.meetings.create(title, userId);
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
      let merged: MergedSource | null = null;
      const speakers = new Map<string, LiveAudioSource>();
      if (request.source === "live") {
        live = this.newLiveSource(deepgram, 0);
        // Every live microphone is one person's, so its segments are theirs, whatever Deepgram
        // heard. Others join the merge as they connect.
        merged = new MergedSource({ source: live, speakerKey: userSpeakerKey(userId) }, (ended, error) => {
          for (const [id, input] of speakers) if (input === ended) speakers.delete(id);
          if (error) this.log(`MEETING ${meeting.id} a microphone failed`, error);
        });
        source = merged;
        this.bindSpeaker(meeting.id, userId, "host");
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
      this.running.set(meeting.id, {
        meetingId: meeting.id,
        userId,
        source: request.source,
        abort,
        live,
        merged,
        speakers,
        deepgram,
        startedAt,
        done: this.run(meeting.id, source, appender, abort),
      });
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
      this.running.delete(meetingId);
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
