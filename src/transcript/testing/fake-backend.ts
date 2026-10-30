// Test double for backend/server: the same REST routes and WebSocket frames, in memory.
// Bun-only; excluded from the app's tsconfig.
import type { BackendChat, BackendChatKind, BackendChatMessage, BackendChatRole } from '../../types/meeting-chat';
import type { Meeting, TranscriptSegment } from '../../types/transcript';

type SocketData =
  | { kind: 'stream'; meetingId: string; after: number }
  | { kind: 'audio'; meetingId: string }
  | { kind: 'chat'; meetingId: string; chatId: string; after: number };

export class FakeBackend {
  readonly segments = new Map<string, TranscriptSegment[]>();
  readonly meetings = new Map<string, Meeting>();
  readonly audioFrames: Uint8Array[] = [];
  readonly streams = new Set<Bun.ServerWebSocket<SocketData>>();
  readonly audios = new Set<Bun.ServerWebSocket<SocketData>>();
  readonly chats = new Map<string, BackendChat[]>();
  readonly chatMessages = new Map<string, BackendChatMessage[]>();
  readonly chatSockets = new Set<Bun.ServerWebSocket<SocketData>>();
  /** Every message posted to a chat, in order, as the backend received it. */
  readonly chatPosts: { chatId: string; messageId: string; text: string; mode: string }[] = [];
  /** Chat stream sockets opened, with the resume point each asked for. */
  chatStreamOpens: { chatId: string; after: number }[] = [];
  /** Invite tokens the fake accepts, by the meeting they open. */
  readonly invites = new Map<string, string>();
  /** Meetings the caller joined through a link, so they read as role "participant". */
  readonly participantIn = new Set<string>();
  /** Meetings the owner removed the caller from: they answer 404 from then on. */
  readonly removedFrom = new Set<string>();
  /** Meeting ids the caller left, in order. */
  leaves: string[] = [];
  heartbeatMs = 60_000;
  /** Sent right after "ready" on every stream connection (tests inject frames here). */
  afterReady: ((ws: Bun.ServerWebSocket<SocketData>) => void) | null = null;
  ends = 0;
  starts: unknown[] = [];
  refuseStreams = false;
  /** Stream sockets opened, with the resume point each asked for. */
  streamOpens: { meetingId: string; after: number }[] = [];
  /**
   * Accounts the fake knows, by email. Once `requireAuth` is on, every route but /healthz and
   * /api/auth answers 401 (REST and WebSocket upgrades alike) unless it carries a token this
   * fake issued at sign-in or sign-up.
   */
  readonly accounts = new Map<string, { password: string; user: { id: string; email: string; name: string } }>();
  readonly tokens = new Map<string, string>();
  requireAuth = false;
  /** Origin header of each sign-in, sign-up and sign-out call, in order. */
  authOrigins: (string | null)[] = [];
  /** Authorization header of each request that reached a protected route (REST and sockets). */
  seenAuthorization: (string | null)[] = [];
  private server!: ReturnType<typeof Bun.serve>;
  private counter = 0;
  private port = 0;

  get url(): string {
    return `http://localhost:${this.port}`;
  }

  start(port = 0): this {
    this.server = Bun.serve<SocketData>({
      port,
      fetch: (req, server) => this.handle(req, server),
      websocket: {
        open: (ws) => this.onOpen(ws),
        message: (ws, message) => {
          if (ws.data.kind === 'audio' && typeof message !== 'string') {
            this.audioFrames.push(new Uint8Array(message));
          }
        },
        close: (ws) => {
          this.streams.delete(ws);
          this.audios.delete(ws);
          this.chatSockets.delete(ws);
        },
      },
    });
    this.port = this.server.port as number;
    return this;
  }

  async stop(): Promise<void> {
    await this.server.stop(true);
  }

  /** Closes the listener and drops every open socket, as if the backend process died. */
  async kill(): Promise<number> {
    const port = this.port;
    for (const ws of [...this.streams, ...this.audios, ...this.chatSockets]) ws.close(1011, 'killed');
    await this.server.stop(true);
    return port;
  }

  addMeeting(partial: Partial<Meeting> = {}): Meeting {
    const id = partial.id ?? `00000000-0000-4000-8000-${String(++this.counter).padStart(12, '0')}`;
    const meeting: Meeting = {
      id,
      title: 'test',
      role: 'owner',
      status: 'live',
      source: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      createdAt: new Date().toISOString(),
      ...partial,
    };
    this.meetings.set(id, meeting);
    if (!this.segments.has(id)) this.segments.set(id, []);
    return meeting;
  }

  /** Appends a segment and sends it to every open stream of the meeting. */
  push(meetingId: string, text: string, extra: Partial<TranscriptSegment> = {}): TranscriptSegment {
    const log = this.segments.get(meetingId)!;
    const seq = log.length + 1;
    const segment: TranscriptSegment = {
      seq,
      text,
      startMs: seq * 1000,
      endMs: seq * 1000 + 900,
      source: 'deepgram',
      speakerKey: 'spk_0',
      speaker: null,
      createdAt: new Date().toISOString(),
      ...extra,
    };
    log.push(segment);
    for (const ws of this.streams) {
      if (ws.data.kind === 'stream' && ws.data.meetingId === meetingId) {
        ws.send(JSON.stringify({ type: 'segment', ...segment }));
      }
    }
    return segment;
  }

  addChat(meetingId: string, title = ''): BackendChat {
    const chat: BackendChat = {
      id: `10000000-0000-4000-8000-${String(++this.counter).padStart(12, '0')}`,
      meetingId,
      title,
      createdAt: new Date().toISOString(),
    };
    this.chats.set(meetingId, [...(this.chats.get(meetingId) ?? []), chat]);
    this.chatMessages.set(chat.id, []);
    return chat;
  }

  /** Appends a chat message and sends it to every open stream of the chat. */
  pushChatMessage(
    chatId: string,
    role: BackendChatRole,
    kind: BackendChatKind,
    content: string,
    extra: Partial<BackendChatMessage> = {},
  ): BackendChatMessage {
    const log = this.chatMessages.get(chatId)!;
    const message: BackendChatMessage = {
      id: crypto.randomUUID(),
      seq: log.length + 1,
      role,
      kind,
      content,
      transcriptSeq: null,
      createdAt: new Date().toISOString(),
      ...extra,
    };
    log.push(message);
    for (const ws of this.chatSockets) {
      if (ws.data.kind === 'chat' && ws.data.chatId === chatId) ws.send(JSON.stringify({ type: 'message', ...message }));
    }
    return message;
  }

  dropChatStreams(code = 1006): void {
    for (const ws of this.chatSockets) ws.close(code, 'dropped');
  }

  broadcastChat(frame: unknown): void {
    for (const ws of this.chatSockets) ws.send(JSON.stringify(frame));
  }

  /** The meeting as the caller sees it. */
  private view(meeting: Meeting): Meeting {
    return this.participantIn.has(meeting.id) ? { ...meeting, role: 'participant' } : meeting;
  }

  /** The owner takes the caller out of the meeting. */
  removeParticipant(meetingId: string): void {
    this.participantIn.delete(meetingId);
    this.removedFrom.add(meetingId);
    for (const ws of [...this.streams, ...this.audios]) if (ws.data.meetingId === meetingId) ws.close(4403, 'removed from meeting');
  }

  end(meetingId: string): void {
    const meeting = this.meetings.get(meetingId);
    if (meeting) this.meetings.set(meetingId, { ...meeting, status: 'ended', source: null, endedAt: new Date().toISOString() });
  }

  dropStreams(code = 1006): void {
    for (const ws of this.streams) ws.close(code, 'dropped');
  }

  broadcast(frame: unknown): void {
    for (const ws of this.streams) ws.send(JSON.stringify(frame));
  }

  private onOpen(ws: Bun.ServerWebSocket<SocketData>): void {
    if (ws.data.kind === 'audio') {
      this.audios.add(ws);
      return;
    }
    if (ws.data.kind === 'chat') {
      this.onChatOpen(ws, ws.data);
      return;
    }
    const { meetingId, after } = ws.data;
    this.streamOpens.push({ meetingId, after });
    const log = this.segments.get(meetingId) ?? [];
    if (after > log.length) {
      ws.send(JSON.stringify({ type: 'error', code: 'cursor_ahead', message: `after=${after} is beyond the log head ${log.length}` }));
      ws.close(4409, 'cursor ahead of head');
      return;
    }
    ws.send(JSON.stringify({ type: 'ready', stream: 'transcript', meetingId, after, head: log.length, heartbeatMs: this.heartbeatMs }));
    this.streams.add(ws);
    for (const segment of log.slice(after)) ws.send(JSON.stringify({ type: 'segment', ...segment }));
    this.afterReady?.(ws);
  }

  private onChatOpen(ws: Bun.ServerWebSocket<SocketData>, data: { meetingId: string; chatId: string; after: number }): void {
    const { meetingId, chatId, after } = data;
    this.chatStreamOpens.push({ chatId, after });
    const log = this.chatMessages.get(chatId) ?? [];
    if (after > log.length) {
      ws.send(JSON.stringify({ type: 'error', code: 'cursor_ahead', message: `after=${after} is beyond the chat head ${log.length}` }));
      ws.close(4409, 'cursor ahead of head');
      return;
    }
    ws.send(JSON.stringify({ type: 'ready', stream: 'chat', meetingId, chatId, after, head: log.length, heartbeatMs: this.heartbeatMs }));
    this.chatSockets.add(ws);
    for (const message of log.slice(after)) ws.send(JSON.stringify({ type: 'message', ...message }));
  }

  private async handleChats(
    req: Request,
    server: Bun.Server<SocketData>,
    url: URL,
    meetingId: string,
    parts: string[],
  ): Promise<Response | undefined> {
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    const chatId = parts[3];
    if (!chatId) {
      if (req.method === 'GET') return json({ chats: this.chats.get(meetingId) ?? [] });
      if (req.method === 'POST') {
        const body = (await req.json()) as { title?: string };
        return json(this.addChat(meetingId, body.title ?? ''), 201);
      }
    }
    const chat = (this.chats.get(meetingId) ?? []).find((c) => c.id === chatId);
    if (!chat) return json({ error: 'not found' }, 404);
    const log = this.chatMessages.get(chat.id)!;
    if (parts[4] === 'messages' && req.method === 'POST') {
      const body = (await req.json()) as { messageId?: string; mode?: string; text?: string };
      if (!body.text?.trim()) return json({ error: 'invalid body' }, 400);
      const messageId = body.messageId ?? crypto.randomUUID();
      this.chatPosts.push({ chatId: chat.id, messageId, text: body.text, mode: body.mode ?? 'followup' });
      if (log.some((m) => m.id === messageId)) return json({ messageId, created: false });
      this.pushChatMessage(chat.id, 'user', (body.mode ?? 'followup') as BackendChatKind, body.text, { id: messageId });
      return json({ messageId, created: true }, 202);
    }
    if (parts[4] === 'messages' && req.method === 'GET') {
      const after = Number(url.searchParams.get('after') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '100');
      return json({ messages: log.filter((m) => m.seq > after).slice(0, limit), head: log.length });
    }
    if (parts[4] === 'stream') {
      if (this.refuseStreams) return json({ error: 'unavailable' }, 503);
      const after = Number(url.searchParams.get('after') ?? '0');
      if (server.upgrade(req, { data: { kind: 'chat', meetingId, chatId: chat.id, after } })) return undefined;
      return json({ error: 'upgrade failed' }, 400);
    }
    return json({ error: 'not found' }, 404);
  }

  /** Issues a token for the account and returns the response Better Auth would. */
  addAccount(email: string, password: string, name = 'Test User'): { id: string; email: string; name: string } {
    const user = { id: `user-${++this.counter}`, email: email.toLowerCase(), name };
    this.accounts.set(user.email, { password, user });
    return user;
  }

  /** A token that works until revoke() is called. For tests that start already signed in. */
  issueToken(email: string): string {
    const token = `tok-${crypto.randomUUID()}`;
    this.tokens.set(token, email.toLowerCase());
    return token;
  }

  /** Makes the backend forget the token, as if the session expired. */
  revoke(token: string): void {
    this.tokens.delete(token);
  }

  private userOf(token: string) {
    return this.accounts.get(this.tokens.get(token)!)?.user ?? null;
  }

  private async handleAuth(req: Request, url: URL, json: (body: unknown, status?: number) => Response): Promise<Response> {
    this.authOrigins.push(req.headers.get('origin'));
    // Like Better Auth, refuse a null origin and any origin that is not the app's.
    const origin = req.headers.get('origin');
    if (origin !== null && origin !== 'interview-assistant://app') return json({ message: 'Invalid origin' }, 403);
    const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string; name?: string };
    const done = (email: string) => {
      const token = this.issueToken(email);
      return new Response(JSON.stringify({ token, user: this.accounts.get(email)!.user }), {
        headers: { 'content-type': 'application/json', 'set-auth-token': token },
      });
    };
    if (url.pathname === '/api/auth/sign-up/email') {
      const email = (body.email ?? '').toLowerCase();
      if (this.accounts.has(email)) return json({ message: 'User already exists', code: 'USER_ALREADY_EXISTS' }, 422);
      this.addAccount(email, body.password ?? '', body.name ?? '');
      return done(email);
    }
    if (url.pathname === '/api/auth/sign-in/email') {
      const email = (body.email ?? '').toLowerCase();
      const account = this.accounts.get(email);
      if (!account || account.password !== body.password) {
        return json({ message: 'Invalid email or password', code: 'INVALID_EMAIL_OR_PASSWORD' }, 401);
      }
      return done(email);
    }
    if (url.pathname === '/api/auth/sign-out') {
      const token = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1];
      if (token) this.tokens.delete(token);
      return json({ success: true });
    }
    return json({ error: 'not found' }, 404);
  }

  private async handle(req: Request, server: Bun.Server<SocketData>): Promise<Response | undefined> {
    const url = new URL(req.url);
    const json = (body: unknown, status = 200) => Response.json(body, { status });
    const parts = url.pathname.split('/').filter(Boolean);

    if (url.pathname === '/healthz') return json({ ok: true });

    if (url.pathname.startsWith('/api/auth/')) return this.handleAuth(req, url, json);
    if (this.requireAuth) {
      const header = req.headers.get('authorization');
      this.seenAuthorization.push(header);
      const token = /^Bearer (.+)$/.exec(header ?? '')?.[1];
      if (!token || !this.tokens.has(token)) return json({ error: 'unauthorized' }, 401);
      if (url.pathname === '/me') return json(this.userOf(token));
    }

    if (url.pathname === '/invites/redeem' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { token?: string };
      const meetingId = body.token ? this.invites.get(body.token) : undefined;
      const joined = meetingId ? this.meetings.get(meetingId) : undefined;
      if (!joined || joined.status === 'ended') return json({ error: 'not found' }, 404);
      this.removedFrom.delete(joined.id);
      this.participantIn.add(joined.id);
      return json(this.view(joined));
    }

    if (parts[0] === 'meetings') {
      const id = parts[1];
      if (id && this.removedFrom.has(id) && !this.participantIn.has(id)) return json({ error: 'not found' }, 404);
      if (id && parts[2] === 'leave' && req.method === 'POST') {
        if (!this.participantIn.delete(id)) return json({ error: 'not found' }, 404);
        this.leaves.push(id);
        return new Response(null, { status: 204 });
      }
      if (id && parts[2] === 'chats' && this.meetings.has(id)) return this.handleChats(req, server, url, id, parts);
      if (!id && req.method === 'GET') {
        return json({ meetings: [...this.meetings.values()].reverse() });
      }
      if (!id && req.method === 'POST') {
        const body = await req.json();
        this.starts.push(body);
        const live = [...this.meetings.values()].find((m) => m.status === 'live');
        if (live) return json({ error: 'a meeting is already live', meetingId: live.id }, 409);
        return json(this.addMeeting({ source: (body as { source: Meeting['source'] }).source }), 201);
      }
      const meeting = id ? this.meetings.get(id) : undefined;
      if (id && !parts[2] && req.method === 'GET') {
        return meeting ? json(this.view(meeting)) : json({ error: 'not found' }, 404);
      }
      if (parts[2] === 'end' && req.method === 'POST') {
        if (!meeting) return json({ error: 'not found' }, 404);
        this.ends++;
        this.end(id!);
        return json(this.meetings.get(id!));
      }
      if (parts[2] === 'stream') {
        if (this.refuseStreams) return json({ error: 'unavailable' }, 503);
        if (!meeting) return json({ error: 'not found' }, 404);
        const after = Number(url.searchParams.get('after') ?? '0');
        if (server.upgrade(req, { data: { kind: 'stream', meetingId: id!, after } })) return undefined;
        return json({ error: 'upgrade failed' }, 400);
      }
      if (parts[2] === 'audio') {
        if (!meeting || meeting.status !== 'live') return json({ error: 'meeting is not taking live audio' }, 409);
        if (server.upgrade(req, { data: { kind: 'audio', meetingId: id! } })) return undefined;
        return json({ error: 'upgrade failed' }, 400);
      }
    }
    return json({ error: 'not found' }, 404);
  }
}

export async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}
