import { APP_ORIGIN } from '../../auth/constants';
import type { AuthUser, SignInInput, SignUpInput } from '../../types/auth';
import type { BackendChat, BackendChatMessage, SendMode } from '../../types/meeting-chat';
import type {
  CreatedInvite,
  CreateInviteInput,
  Meeting,
  MeetingInvite,
  MeetingMember,
  StartMeetingInput,
} from '../../types/transcript';

export class BackendApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** Set on 409 when a meeting is already live. */
    readonly meetingId?: string,
  ) {
    super(message);
    this.name = 'BackendApiError';
  }
}

const REQUEST_TIMEOUT_MS = 8_000;
// Ending a meeting waits for the server to drain queued segments.
const END_TIMEOUT_MS = 20_000;

export type FetchLike = typeof fetch;

interface RequestOptions {
  method?: string;
  body?: unknown;
  timeoutMs?: number;
  /** Present the app's origin, which the backend requires on sign-in, sign-up and sign-out. */
  appOrigin?: boolean;
  /** False for calls whose 401 means "wrong credentials" or is handled by the caller. */
  notifyUnauthorized?: boolean;
}

/**
 * REST calls to the transcript backend. The base URL can change at runtime. Once a session
 * token is set it goes on every request and every socket as `Authorization: Bearer`; it is
 * never put in a URL or an error message.
 */
export class BackendApi {
  private token: string | null = null;
  private unauthorized: (() => void) | null = null;

  constructor(
    private baseUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  setBaseUrl(url: string): void {
    this.baseUrl = url;
  }

  get url(): string {
    return this.baseUrl;
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  get hasToken(): boolean {
    return this.token !== null;
  }

  /** Called when the backend answers 401 to a request that carried the token. */
  onUnauthorized(handler: (() => void) | null): void {
    this.unauthorized = handler;
  }

  /** The headers a socket upgrade needs to be accepted as the signed-in user. */
  authHeaders(): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token}` } : {};
  }

  /** Opens a WebSocket as the signed-in user. Electron's main-process WebSocket takes headers. */
  openSocket = (url: string): WebSocket =>
    new WebSocket(url, { headers: this.authHeaders() } as unknown as string[]);

  signUp(input: SignUpInput): Promise<{ token: string; user: AuthUser }> {
    return this.authenticate('/api/auth/sign-up/email', input);
  }

  signIn(input: SignInInput): Promise<{ token: string; user: AuthUser }> {
    return this.authenticate('/api/auth/sign-in/email', input);
  }

  async signOut(): Promise<void> {
    await this.request('/api/auth/sign-out', { method: 'POST', body: {}, appOrigin: true, notifyUnauthorized: false });
  }

  /** Who the token belongs to. A 401 here is for the caller to handle, not a lost session. */
  me(): Promise<AuthUser> {
    return this.request<AuthUser>('/me', { notifyUnauthorized: false });
  }

  async health(): Promise<void> {
    await this.request('/healthz');
  }

  async listMeetings(limit = 50): Promise<Meeting[]> {
    const body = await this.request<{ meetings: Meeting[] }>(`/meetings?limit=${limit}`);
    return body.meetings;
  }

  getMeeting(id: string): Promise<Meeting> {
    return this.request<Meeting>(`/meetings/${encodeURIComponent(id)}`);
  }

  startMeeting(input: StartMeetingInput): Promise<Meeting> {
    return this.request<Meeting>('/meetings', { method: 'POST', body: input });
  }

  endMeeting(id: string): Promise<Meeting> {
    return this.request<Meeting>(`/meetings/${encodeURIComponent(id)}/end`, {
      method: 'POST',
      timeoutMs: END_TIMEOUT_MS,
    });
  }

  /** Turns an invite link's token into membership of the meeting it belongs to. */
  redeemInvite(token: string): Promise<Meeting> {
    return this.request<Meeting>('/invites/redeem', { method: 'POST', body: { token } });
  }

  async leaveMeeting(meetingId: string): Promise<void> {
    await this.request(`/meetings/${encodeURIComponent(meetingId)}/leave`, { method: 'POST' });
  }

  createInvite(meetingId: string, input: CreateInviteInput): Promise<CreatedInvite> {
    return this.request<CreatedInvite>(`/meetings/${encodeURIComponent(meetingId)}/invites`, {
      method: 'POST',
      body: input,
    });
  }

  async listInvites(meetingId: string): Promise<MeetingInvite[]> {
    const body = await this.request<{ invites: MeetingInvite[] }>(`/meetings/${encodeURIComponent(meetingId)}/invites`);
    return body.invites;
  }

  async revokeInvite(meetingId: string, inviteId: string): Promise<void> {
    await this.request(`/meetings/${encodeURIComponent(meetingId)}/invites/${encodeURIComponent(inviteId)}`, {
      method: 'DELETE',
    });
  }

  async listMembers(meetingId: string): Promise<MeetingMember[]> {
    const body = await this.request<{ members: MeetingMember[] }>(`/meetings/${encodeURIComponent(meetingId)}/members`);
    return body.members;
  }

  async removeMember(meetingId: string, userId: string): Promise<void> {
    await this.request(`/meetings/${encodeURIComponent(meetingId)}/members/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
    });
  }

  async listChats(meetingId: string): Promise<BackendChat[]> {
    const body = await this.request<{ chats: BackendChat[] }>(`/meetings/${encodeURIComponent(meetingId)}/chats`);
    return body.chats;
  }

  createChat(meetingId: string, title = ''): Promise<BackendChat> {
    return this.request<BackendChat>(`/meetings/${encodeURIComponent(meetingId)}/chats`, {
      method: 'POST',
      body: { title },
    });
  }

  /** The reply arrives on the chat's stream, not in this response. */
  postChatMessage(
    meetingId: string,
    chatId: string,
    message: { messageId: string; text: string; mode: SendMode },
  ): Promise<{ messageId: string; created: boolean }> {
    return this.request(`/meetings/${encodeURIComponent(meetingId)}/chats/${encodeURIComponent(chatId)}/messages`, {
      method: 'POST',
      body: message,
    });
  }

  async listChatMessages(
    meetingId: string,
    chatId: string,
    after = 0,
    limit = 100,
  ): Promise<{ messages: BackendChatMessage[]; head: number }> {
    return this.request(
      `/meetings/${encodeURIComponent(meetingId)}/chats/${encodeURIComponent(chatId)}/messages?after=${after}&limit=${limit}`,
    );
  }

  private async authenticate(path: string, body: unknown): Promise<{ token: string; user: AuthUser }> {
    const { json, headers } = await this.send<{ user?: AuthUser }>(path, {
      method: 'POST',
      body,
      appOrigin: true,
      notifyUnauthorized: false,
    });
    const token = headers.get('set-auth-token');
    if (!token || !json?.user) throw new BackendApiError('the backend did not return a session', null);
    const { id, email, name } = json.user;
    return { token, user: { id, email, name } };
  }

  private async request<T = unknown>(path: string, init: RequestOptions = {}): Promise<T> {
    return (await this.send<T>(path, init)).json as T;
  }

  private async send<T>(path: string, init: RequestOptions): Promise<{ json: T | null; headers: Headers }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init.appOrigin ? { origin: APP_ORIGIN } : {}),
          ...this.authHeaders(),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(init.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new BackendApiError(
        timedOut ? `the backend at ${this.baseUrl} did not answer in time` : `cannot reach the backend at ${this.baseUrl}`,
        null,
      );
    }
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }
    if (response.status === 401 && this.token && init.notifyUnauthorized !== false) this.unauthorized?.();
    if (!response.ok) {
      const record = (json ?? {}) as { error?: string; message?: string; meetingId?: string };
      throw new BackendApiError(
        record.error ?? record.message ?? `backend returned ${response.status}`,
        response.status,
        record.meetingId,
      );
    }
    return { json: json as T | null, headers: response.headers };
  }
}
