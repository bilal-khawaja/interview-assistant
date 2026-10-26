import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { MeetingRepository } from "../db/repositories/meeting.repository";
import { mountChatRoutes, type ChatApiDeps } from "./chat-routes";
import { mountMeetingRoutes, type MeetingApiDeps } from "./meeting-routes";
import { sinkFor } from "./sink";
import { runTranscriptStream, type StreamDeps } from "./transcript-stream";

export type AppDeps = StreamDeps & {
  meetings: Pick<MeetingRepository, "findById">;
  /** Without it the server only streams transcripts. */
  chat?: ChatApiDeps;
  /** Without it meetings can only be started outside the server (the producer script). */
  meetingApi?: MeetingApiDeps;
};

export type StreamVariables = { meetingId: string; chatId: string; after: number; audioMeetingId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createApp(deps: AppDeps) {
  const app = new Hono<{ Variables: StreamVariables }>();

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.get(
    "/meetings/:id/stream",
    async (c, next) => {
      const meetingId = c.req.param("id");
      if (!UUID.test(meetingId) || !(await deps.meetings.findById(meetingId))) {
        return c.json({ error: "not found" }, 404);
      }

      const raw = c.req.query("after") ?? "0";
      if (!/^\d{1,9}$/.test(raw)) {
        return c.json({ error: "after must be a non-negative integer" }, 400);
      }

      c.set("meetingId", meetingId);
      c.set("after", Number(raw));
      await next();
    },
    upgradeWebSocket((c) => {
      const meetingId = c.get("meetingId");
      const after = c.get("after");
      const abort = new AbortController();

      return {
        onOpen(_event, ws) {
          void runTranscriptStream(deps, sinkFor(ws), meetingId, after, abort.signal);
        },
        onClose() {
          abort.abort();
        },
        onError() {
          abort.abort();
        },
      };
    }),
  );

  if (deps.meetingApi) mountMeetingRoutes(app, deps.meetingApi);

  if (deps.chat) {
    mountChatRoutes(app, deps.chat, async (id) => (await deps.meetings.findById(id)) !== null);
  }

  return app;
}

