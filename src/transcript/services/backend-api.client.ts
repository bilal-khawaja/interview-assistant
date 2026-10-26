import type { Meeting, StartMeetingInput } from '../../types/transcript';

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

/** REST calls to the transcript backend. The base URL can change at runtime. */
export class BackendApi {
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

  private async request<T = unknown>(
    path: string,
    init: { method?: string; body?: unknown; timeoutMs?: number } = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
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
    if (!response.ok) {
      const record = (json ?? {}) as { error?: string; meetingId?: string };
      throw new BackendApiError(record.error ?? `backend returned ${response.status}`, response.status, record.meetingId);
    }
    return json as T;
  }
}
