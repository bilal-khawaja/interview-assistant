import type {
  CreatedInvite,
  CreateInviteInput,
  Meeting,
  MeetingChangedEvent,
  MeetingInvite,
  MeetingMember,
  StartMeetingInput,
  StreamStatus,
  TranscriptResetEvent,
  TranscriptSegmentEvent,
  TranscriptStatusEvent,
} from '../../types/transcript';
import { normalizeBackendUrl } from '../backend-url';
import { AudioUplink, type AudioUplinkOptions } from './audio-uplink';
import { BackendApi, BackendApiError } from './backend-api.client';
import { TranscriptStreamClient, type StreamClientOptions } from './transcript-stream.client';

export type TranscriptEvent =
  | { type: 'segment'; event: TranscriptSegmentEvent }
  | { type: 'status'; event: TranscriptStatusEvent }
  | { type: 'reset'; event: TranscriptResetEvent }
  | { type: 'meeting'; event: MeetingChangedEvent };

export interface MeetingServiceOptions {
  /** How often the open meeting's status is re-read. */
  pollMs?: number;
  /** A finished meeting is closed once its stream has been quiet this long. */
  drainMs?: number;
  /** Longest the drain waits before closing anyway. */
  drainMaxMs?: number;
  /** How long quitting waits for the server to end the meeting. */
  quitEndTimeoutMs?: number;
  streamOptions?: Partial<StreamClientOptions>;
  uplinkOptions?: Partial<AudioUplinkOptions>;
}

interface Current {
  meeting: Meeting;
  /** Started by this app, so quitting the app ends it. */
  owned: boolean;
  /** Someone else's meeting whose microphone this app feeds. */
  speaking: boolean;
  stream: TranscriptStreamClient;
  uplink: AudioUplink | null;
  poll: ReturnType<typeof setInterval>;
  finishing: boolean;
  closed: boolean;
}

const DEFAULT_POLL_MS = 3_000;
const DEFAULT_DRAIN_MS = 1_000;
const DEFAULT_DRAIN_MAX_MS = 15_000;
const DEFAULT_QUIT_END_TIMEOUT_MS = 8_000;
const DRAIN_CHECK_MS = 200;

/**
 * The app's side of a meeting: starts and ends it on the backend, follows its transcript
 * stream, and forwards microphone audio for live meetings. One meeting is followed at a
 * time. Everything the renderer needs is pushed through listeners as plain events.
 */
export class MeetingService {
  private current: Current | null = null;
  private readonly listeners = new Set<(event: TranscriptEvent) => void>();

  constructor(
    readonly api: BackendApi,
    private readonly options: MeetingServiceOptions = {},
  ) {}

  onEvent(listener: (event: TranscriptEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  configure(backendUrl: string): string {
    const url = normalizeBackendUrl(backendUrl);
    this.api.setBaseUrl(url);
    return url;
  }

  get activeMeeting(): Meeting | null {
    return this.current?.meeting ?? null;
  }

  /** Whether the followed meeting was started by this app (and so ends when the app quits). */
  get activeIsOwned(): boolean {
    return this.current?.owned === true;
  }

  /** Whether this app sends its microphone into a meeting somebody else started. */
  get activeIsSpeaking(): boolean {
    return this.current?.speaking === true;
  }

  health(): Promise<void> {
    return this.api.health();
  }

  list(): Promise<Meeting[]> {
    return this.api.listMeetings();
  }

  /** Creates the meeting, follows its transcript and, for a live meeting, opens the audio path. */
  async start(input: StartMeetingInput): Promise<Meeting> {
    const meeting = await this.api.startMeeting(input);
    this.open(meeting, { owned: true, audio: input.source === 'live' });
    return meeting;
  }

  /** Follows an existing meeting's transcript from its first segment. */
  async subscribe(meetingId: string): Promise<Meeting> {
    const meeting = await this.api.getMeeting(meetingId);
    const same = this.current?.meeting.id === meetingId ? this.current : null;
    // A window that reloads picks the meeting up again with the same role and microphone link.
    this.open(meeting, { owned: same?.owned === true, audio: same !== null && same.uplink !== null });
    return meeting;
  }

  /**
   * Joins the meeting an invite link belongs to and follows it. With `speak`, and while the
   * meeting is live, this app's microphone is sent into it too.
   */
  async join(token: string, speak: boolean): Promise<Meeting> {
    const meeting = await this.api.redeemInvite(token);
    const audio = meeting.role === 'participant' && speak && meeting.status === 'live' && meeting.source === 'live';
    this.open(meeting, { owned: meeting.role === 'owner', audio });
    return meeting;
  }

  /** Leaves a meeting joined through a link. The owner cannot leave, only end it. */
  async leave(meetingId: string): Promise<void> {
    const current = this.current?.meeting.id === meetingId ? this.current : null;
    current?.uplink?.close();
    try {
      await this.api.leaveMeeting(meetingId);
    } catch (error) {
      // Already out (removed, or the meeting is gone): the aim is reached.
      if (!(error instanceof BackendApiError && error.status === 404)) throw error;
    }
    if (current && !current.closed) this.closeCurrent();
  }

  createInvite(meetingId: string, input: CreateInviteInput): Promise<CreatedInvite> {
    return this.api.createInvite(meetingId, input);
  }

  listInvites(meetingId: string): Promise<MeetingInvite[]> {
    return this.api.listInvites(meetingId);
  }

  revokeInvite(meetingId: string, inviteId: string): Promise<void> {
    return this.api.revokeInvite(meetingId, inviteId);
  }

  listMembers(meetingId: string): Promise<MeetingMember[]> {
    return this.api.listMembers(meetingId);
  }

  removeMember(meetingId: string, userId: string): Promise<void> {
    return this.api.removeMember(meetingId, userId);
  }

  unsubscribe(): void {
    this.closeCurrent();
  }

  /** Ends a meeting on the backend. Stops audio first so nothing is sent to a closing meeting. */
  async end(meetingId: string): Promise<Meeting> {
    const current = this.current?.meeting.id === meetingId ? this.current : null;
    current?.uplink?.close();
    const meeting = await this.api.endMeeting(meetingId);
    if (current && !current.closed) {
      current.meeting = meeting;
      this.emit({ type: 'meeting', event: { meeting } });
      void this.finish(current);
    }
    return meeting;
  }

  /** True while a meeting this app started is still running, so quitting must end it first. */
  get hasOwnedLiveMeeting(): boolean {
    return this.current?.owned === true && this.current.meeting.status !== 'ended';
  }

  /** For quitting the app: ends the meeting this app started, if it is still running. */
  async endOwnedMeeting(): Promise<void> {
    const current = this.current;
    if (!current?.owned || current.meeting.status === 'ended') return;
    const timeout = this.options.quitEndTimeoutMs ?? DEFAULT_QUIT_END_TIMEOUT_MS;
    await Promise.race([
      this.end(current.meeting.id).catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, timeout)),
    ]);
  }

  sendAudio(chunk: Uint8Array): boolean {
    const uplink = this.current?.uplink;
    if (!uplink) return false;
    uplink.push(chunk);
    return true;
  }

  dispose(): void {
    this.closeCurrent();
    this.listeners.clear();
  }

  private emit(event: TranscriptEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a dead window must not break delivery to the others
      }
    }
  }

  private open(meeting: Meeting, { owned, audio }: { owned: boolean; audio: boolean }): void {
    this.closeCurrent();
    const meetingId = meeting.id;
    const baseUrl = this.api.url;

    const stream = new TranscriptStreamClient({
      baseUrl,
      meetingId,
      onSegment: (segment) => this.emit({ type: 'segment', event: { meetingId, segment } }),
      onStatus: (status, detail) => this.emitStatus(meetingId, status, detail),
      onReset: () => this.emit({ type: 'reset', event: { meetingId } }),
      createSocket: this.api.openSocket,
      ...this.options.streamOptions,
    });
    const uplink = audio
      ? new AudioUplink({
          baseUrl,
          meetingId,
          createSocket: this.api.openSocket,
          onState: (state, detail) => {
            if (state === 'reconnecting') this.emitStatus(meetingId, 'reconnecting', `microphone link: ${detail ?? 'reconnecting'}`);
          },
          ...this.options.uplinkOptions,
        })
      : null;

    const current: Current = {
      meeting,
      owned,
      speaking: !owned && uplink !== null,
      stream,
      uplink,
      poll: setInterval(() => void this.refresh(current), this.options.pollMs ?? DEFAULT_POLL_MS),
      finishing: false,
      closed: false,
    };
    this.current = current;
    this.emit({ type: 'meeting', event: { meeting } });
    stream.start();
    uplink?.start();
    if (meeting.status === 'ended') void this.finish(current);
  }

  private emitStatus(meetingId: string, status: StreamStatus, detail?: string): void {
    if (this.current?.meeting.id !== meetingId) return;
    this.emit({ type: 'status', event: { meetingId, status, detail } });
  }

  private async refresh(current: Current): Promise<void> {
    if (current.closed || current.finishing) return;
    try {
      const meeting = await this.api.getMeeting(current.meeting.id);
      if (current.closed) return;
      const changed = meeting.status !== current.meeting.status;
      current.meeting = meeting;
      if (changed) this.emit({ type: 'meeting', event: { meeting } });
      if (meeting.status === 'ended') void this.finish(current);
    } catch (error) {
      // The meeting is gone from this account's view: the owner removed it. Stop following it.
      if (error instanceof BackendApiError && error.status === 404 && !current.owned) {
        this.emit({ type: 'status', event: { meetingId: current.meeting.id, status: 'removed' } });
        this.closeCurrent();
      }
      // Otherwise the backend is unreachable; the stream reports that, and polling continues.
    }
  }

  /** The meeting is over: stop sending audio, deliver what is left, then report it ended. */
  private async finish(current: Current): Promise<void> {
    if (current.finishing || current.closed) return;
    current.finishing = true;
    current.uplink?.close();
    const drainMs = this.options.drainMs ?? DEFAULT_DRAIN_MS;
    const deadline = Date.now() + (this.options.drainMaxMs ?? DEFAULT_DRAIN_MAX_MS);
    while (!current.closed && Date.now() < deadline && current.stream.quietMs() < drainMs) {
      await new Promise((resolve) => setTimeout(resolve, DRAIN_CHECK_MS));
    }
    if (current.closed) return;
    this.emit({
      type: 'status',
      event: { meetingId: current.meeting.id, status: 'ended' },
    });
    this.closeCurrent();
  }

  private closeCurrent(): void {
    const current = this.current;
    if (!current) return;
    current.closed = true;
    clearInterval(current.poll);
    current.stream.stop();
    current.uplink?.close();
    this.current = null;
  }
}
