import type {
  ApiResult,
  Meeting,
  MeetingChangedEvent,
  StartMeetingInput,
  StreamStatus,
  TranscriptResetEvent,
  TranscriptSegment,
  TranscriptSegmentEvent,
  TranscriptStatusEvent,
} from '../types/transcript';

/** What the store needs from the main process. The app wires this to tipc. */
export interface TranscriptApi {
  configure(backendUrl: string): Promise<ApiResult<{ url: string }>>;
  health(): Promise<ApiResult<{ ok: true }>>;
  list(): Promise<ApiResult<{ meetings: Meeting[] }>>;
  active(): Promise<{ meeting: Meeting | null; owned: boolean }>;
  start(input: StartMeetingInput): Promise<ApiResult<{ meeting: Meeting }>>;
  end(meetingId: string): Promise<ApiResult<{ meeting: Meeting }>>;
  subscribe(meetingId: string): Promise<ApiResult<{ meeting: Meeting }>>;
  unsubscribe(): Promise<unknown>;
  sendAudio(data: Uint8Array): Promise<unknown>;
  listen(handlers: {
    onSegment: (e: TranscriptSegmentEvent) => void;
    onStatus: (e: TranscriptStatusEvent) => void;
    onReset: (e: TranscriptResetEvent) => void;
    onMeeting: (e: MeetingChangedEvent) => void;
  }): () => void;
}

export interface RunningMic {
  stop(): void;
}

export interface MicStarter {
  start(options: {
    deviceId?: string;
    onChunk: (chunk: Uint8Array) => void;
    onLevel: (level: number) => void;
    onEnded: (reason: string) => void;
  }): Promise<RunningMic>;
  describeError(error: unknown): string;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface MeetingsState {
  /** The meeting on screen: live, or one opened from the list. */
  meeting: Meeting | null;
  segments: TranscriptSegment[];
  status: StreamStatus | null;
  detail: string | null;
  /** This window started a meeting that is still running. */
  runningHere: boolean;
  starting: boolean;
  ending: boolean;
  error: string | null;
  micActive: boolean;
  micLevel: number;
  meetings: Meeting[];
  listLoading: boolean;
  listError: string | null;
  backend: 'unknown' | 'ok' | 'down';
  backendError: string | null;
  backendUrl: string;
}

/** Errors that only mean the backend was briefly unreachable; they go away once it answers again. */
export function isConnectionError(message: string | null): boolean {
  return message !== null && /^(cannot reach the backend|the backend at .* did not answer in time)/.test(message);
}

export const BACKEND_URL_KEY = 'transcript.backendUrl';
export const MIC_DEVICE_KEY = 'transcript.micDeviceId';
export const DEFAULT_BACKEND_URL = 'http://localhost:3000';

// Audio captured while the start request is in flight: five seconds is plenty for a click.
const MAX_PREBUFFER_CHUNKS = 50;

const initialState = (backendUrl: string): MeetingsState => ({
  meeting: null,
  segments: [],
  status: null,
  detail: null,
  runningHere: false,
  starting: false,
  ending: false,
  error: null,
  micActive: false,
  micLevel: 0,
  meetings: [],
  listLoading: false,
  listError: null,
  backend: 'unknown',
  backendError: null,
  backendUrl,
});

export class TranscriptStore {
  private state: MeetingsState;
  private readonly subscribers = new Set<() => void>();
  private mic: RunningMic | null = null;
  private started = false;
  private unlisten: (() => void) | null = null;

  constructor(
    private readonly api: TranscriptApi,
    private readonly micStarter: MicStarter,
    private readonly storage: KeyValueStorage,
  ) {
    this.state = initialState(this.readStorage(BACKEND_URL_KEY) ?? DEFAULT_BACKEND_URL);
  }

  // --- external store contract (useSyncExternalStore) ---

  subscribe = (listener: () => void): (() => void) => {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  };

  getState = (): MeetingsState => this.state;

  private set(patch: Partial<MeetingsState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.subscribers) listener();
  }

  private readStorage(key: string): string | null {
    try {
      return this.storage.getItem(key);
    } catch {
      return null;
    }
  }

  private writeStorage(key: string, value: string): void {
    try {
      this.storage.setItem(key, value);
    } catch {
      // storage unavailable: the choice just will not be remembered
    }
  }

  get savedMicDeviceId(): string | undefined {
    return this.readStorage(MIC_DEVICE_KEY) ?? undefined;
  }

  // --- lifecycle ---

  /** Connects to the main process, checks the backend and picks up a meeting already running. */
  async init(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.unlisten = this.api.listen({
      onSegment: (e) => this.onSegment(e),
      onStatus: (e) => this.onStatus(e),
      onReset: (e) => this.onReset(e),
      onMeeting: (e) => this.onMeeting(e),
    });
    const configured = await this.api.configure(this.state.backendUrl);
    if (configured.error !== undefined) this.set({ backend: 'down', backendError: configured.error });
    await this.checkBackend();
    const active = await this.api.active();
    if (active.meeting && active.meeting.status !== 'ended') {
      await this.resume(active.meeting, active.owned);
    }
    await this.refreshMeetings();
  }

  dispose(): void {
    this.unlisten?.();
    this.unlisten = null;
    this.stopMic();
    this.started = false;
  }

  /** A reloaded window re-attaches to the running meeting and restarts its microphone. */
  private async resume(meeting: Meeting, owned: boolean): Promise<void> {
    this.set({ meeting, segments: [], status: null, detail: null, runningHere: owned && meeting.status === 'live' });
    const result = await this.api.subscribe(meeting.id);
    if (result.error !== undefined) {
      this.set({ error: result.error });
      return;
    }
    if (owned && meeting.source === 'live' && meeting.status === 'live') {
      await this.startMic(this.savedMicDeviceId, () => true, []);
    }
  }

  async checkBackend(): Promise<boolean> {
    const result = await this.api.health();
    if (result.error !== undefined) {
      this.set({ backend: 'down', backendError: result.error });
      return false;
    }
    this.set({ backend: 'ok', backendError: null });
    return true;
  }

  /** Saves and applies a new backend URL. Returns an error message, or null on success. */
  async setBackendUrl(url: string): Promise<string | null> {
    const result = await this.api.configure(url);
    if (result.error !== undefined) return result.error;
    this.writeStorage(BACKEND_URL_KEY, result.url);
    this.set({ backendUrl: result.url });
    await this.checkBackend();
    await this.refreshMeetings();
    return null;
  }

  async refreshMeetings(): Promise<void> {
    this.set({ listLoading: true });
    const result = await this.api.list();
    if (result.error !== undefined) {
      this.set({ listLoading: false, listError: result.error, backend: 'down', backendError: result.error });
      return;
    }
    this.set({
      listLoading: false,
      listError: null,
      meetings: result.meetings,
      backend: 'ok',
      backendError: null,
      ...(isConnectionError(this.state.error) ? { error: null } : {}),
    });
  }

  clearError(): void {
    this.set({ error: null });
  }

  // --- meeting actions ---

  async startMeeting(input: StartMeetingInput, micDeviceId?: string): Promise<boolean> {
    if (this.state.starting || this.state.runningHere) return false;
    this.set({ starting: true, error: null });

    // The microphone opens first, so a denied permission or missing device fails before any
    // meeting exists, and nothing said while the request is in flight is lost.
    const prebuffer: Uint8Array[] = [];
    let ready = false;
    if (input.source === 'live') {
      if (micDeviceId) this.writeStorage(MIC_DEVICE_KEY, micDeviceId);
      const ok = await this.startMic(micDeviceId, () => ready, prebuffer);
      if (!ok) {
        this.set({ starting: false });
        return false;
      }
    }

    const result = await this.api.start(input);
    if (result.error !== undefined) {
      this.stopMic();
      this.set({
        starting: false,
        error:
          result.status === 409
            ? 'A meeting is already running. End it before starting another.'
            : result.error,
      });
      return false;
    }

    ready = true;
    for (const chunk of prebuffer) void this.api.sendAudio(chunk).catch(() => undefined);
    prebuffer.length = 0;
    this.set({ starting: false, runningHere: true, meeting: result.meeting });
    void this.refreshMeetings();
    return true;
  }

  async endMeeting(): Promise<void> {
    const meeting = this.state.meeting;
    if (!meeting || this.state.ending) return;
    this.set({ ending: true, error: null });
    this.stopMic();
    const result = await this.api.end(meeting.id);
    if (result.error !== undefined) {
      this.set({ ending: false, error: result.error });
      return;
    }
    this.set({ ending: false, runningHere: false, meeting: result.meeting });
    void this.refreshMeetings();
  }

  /** Shows a stored or finished meeting. Not allowed while this window is running one. */
  async openMeeting(meetingId: string): Promise<void> {
    if (this.state.runningHere) return;
    this.set({ segments: [], status: null, detail: null, error: null });
    const result = await this.api.subscribe(meetingId);
    if (result.error !== undefined) {
      this.set({ error: result.error });
      return;
    }
    this.set({ meeting: result.meeting });
  }

  async closeMeeting(): Promise<void> {
    if (this.state.runningHere) return;
    await this.api.unsubscribe();
    this.set({ meeting: null, segments: [], status: null, detail: null });
  }

  // --- microphone ---

  private async startMic(
    deviceId: string | undefined,
    isReady: () => boolean,
    prebuffer: Uint8Array[],
  ): Promise<boolean> {
    this.stopMic();
    try {
      this.mic = await this.micStarter.start({
        deviceId,
        onChunk: (chunk) => {
          if (!isReady()) {
            if (prebuffer.length < MAX_PREBUFFER_CHUNKS) prebuffer.push(chunk);
            return;
          }
          void this.api.sendAudio(chunk).catch(() => undefined);
        },
        onLevel: (level) => this.set({ micLevel: level }),
        onEnded: (reason) => {
          this.stopMic();
          this.set({ error: reason });
        },
      });
    } catch (error) {
      this.set({ error: this.micStarter.describeError(error) });
      return false;
    }
    this.set({ micActive: true });
    return true;
  }

  private stopMic(): void {
    this.mic?.stop();
    this.mic = null;
    if (this.state.micActive || this.state.micLevel !== 0) this.set({ micActive: false, micLevel: 0 });
  }

  // --- events from the main process ---

  private onMeeting({ meeting }: MeetingChangedEvent): void {
    const switched = this.state.meeting?.id !== meeting.id;
    this.set({
      meeting,
      ...(switched ? { segments: [], status: null, detail: null } : {}),
    });
    if (meeting.status === 'ended') this.onMeetingOver(meeting.id);
  }

  private onStatus({ meetingId, status, detail }: TranscriptStatusEvent): void {
    if (this.state.meeting?.id !== meetingId) return;
    this.set({
      status,
      detail: detail ?? null,
      // Hearing from the server again proves it is reachable, so a stale "cannot reach" notice goes.
      ...(status === 'live'
        ? { backend: 'ok' as const, backendError: null, ...(isConnectionError(this.state.error) ? { error: null } : {}) }
        : {}),
    });
    if (status === 'ended') this.onMeetingOver(meetingId);
  }

  private onMeetingOver(meetingId: string): void {
    if (this.state.meeting?.id !== meetingId) return;
    if (this.state.runningHere) {
      this.stopMic();
      this.set({ runningHere: false });
    }
    void this.refreshMeetings();
  }

  private onSegment({ meetingId, segment }: TranscriptSegmentEvent): void {
    if (this.state.meeting?.id !== meetingId) return;
    const last = this.state.segments.at(-1);
    if (last && segment.seq <= last.seq) return;
    this.set({ segments: [...this.state.segments, segment] });
  }

  private onReset({ meetingId }: TranscriptResetEvent): void {
    if (this.state.meeting?.id !== meetingId) return;
    this.set({ segments: [] });
  }
}
