import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { MeetingRepository } from "../db/repositories/meeting.repository";
import { currentUserId, mountAuthRoutes, requireAuth, type AuthApi } from "../auth/routes";
import { mountChatRoutes, type ChatApiDeps } from "./chat-routes";
import { mountInviteRoutes, type InviteApiDeps } from "./invite-routes";
import { mountMeetingRoutes, type MeetingApiDeps } from "./meeting-routes";
import type { LiveAudioSource } from "../producer/live-audio";
import { sinkFor } from "./sink";
import { SocketRegistry } from "./socket-registry";
import { runTranscriptStream, type StreamDeps } from "./transcript-stream";

export type AppDeps = StreamDeps & {
  meetings: Pick<MeetingRepository, "findOwned" | "findAccessible">;
  /** Without it the server only streams transcripts. */
  chat?: ChatApiDeps;
  /** Every route except /healthz and /api/auth needs a signed-in user. */
  auth: AuthApi;
  /** Without it meetings can only be started outside the server (the producer script). */
  meetingApi?: MeetingApiDeps;
  /** Invite links and member management. Without it nobody can join a meeting they do not own. */
  invites?: Omit<InviteApiDeps, "sockets">;
};

export type StreamVariables = {
  meetingId: string;
  chatId: string;
  after: number;
  audioMeetingId: string;
  audioUserId: string;
  audioInput: LiveAudioSource;
  streamUserId: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createApp(deps: AppDeps) {
  const app = new Hono<{ Variables: StreamVariables }>();
  const sockets = new SocketRegistry();

  app.get("/healthz", (c) => c.json({ ok: true }));

  mountAuthRoutes(app, deps.auth);

  // Fail closed: anything mounted below needs a signed-in user, WebSocket upgrades included,
  // which are checked here before any data is sent.
  app.use("*", requireAuth(deps.auth));

  app.get(
    "/meetings/:id/stream",
    async (c, next) => {
      const meetingId = c.req.param("id");
      if (!UUID.test(meetingId) || !(await deps.meetings.findAccessible(meetingId, currentUserId(c)))) {
        return c.json({ error: "not found" }, 404);
      }

      const raw = c.req.query("after") ?? "0";
      if (!/^\d{1,9}$/.test(raw)) {
        return c.json({ error: "after must be a non-negative integer" }, 400);
      }

      c.set("meetingId", meetingId);
      c.set("streamUserId", currentUserId(c));
      c.set("after", Number(raw));
      await next();
    },
    upgradeWebSocket((c) => {
      const meetingId = c.get("meetingId");
      const userId = c.get("streamUserId");
      const after = c.get("after");
      const abort = new AbortController();
      let forget = () => {};

      return {
        onOpen(_event, ws) {
          const sink = sinkFor(ws);
          forget = sockets.add(meetingId, userId, { close: (code, reason) => sink.close(code, reason) });
          void runTranscriptStream(deps, sink, meetingId, after, abort.signal);
        },
        onClose() {
          forget();
          abort.abort();
        },
        onError() {
          forget();
          abort.abort();
        },
      };
    }),
  );

  if (deps.meetingApi) mountMeetingRoutes(app, deps.meetingApi, sockets);
  if (deps.invites) mountInviteRoutes(app, { ...deps.invites, sockets });

  if (deps.chat) {
    mountChatRoutes(app, deps.chat, async (id, userId) => (await deps.meetings.findOwned(id, userId)) !== null);
  }

  return app;
}

