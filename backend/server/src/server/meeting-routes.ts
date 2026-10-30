import type { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { z } from "zod";
import { currentUserId } from "../auth/routes";
import type { AccessibleMeeting } from "../db/repositories/meeting.repository";
import type { Meeting } from "../db/schema";
import type { StreamVariables } from "./app";
import type { SocketRegistry } from "./socket-registry";
import {
  MeetingAlreadyLiveError,
  MeetingRequestError,
  type MeetingController,
} from "./meeting-controller";

export type MeetingApiDeps = Pick<
  MeetingController,
  "start" | "end" | "list" | "get" | "sourceOf" | "openAudio"
>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_LIST = 200;
const MAX_YOUTUBE_SECONDS = 4 * 60 * 60;

const startBody = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("youtube"),
    url: z.string().trim().min(1).max(2_000),
    title: z.string().trim().max(200).optional(),
    maxSeconds: z.number().int().min(1).max(MAX_YOUTUBE_SECONDS).optional(),
    realtime: z.boolean().optional(),
  }),
  z.object({
    source: z.literal("live"),
    title: z.string().trim().max(200).optional(),
  }),
]);

export function meetingJson(meeting: Meeting | AccessibleMeeting, source: string | null) {
  return {
    id: meeting.id,
    /** How the caller relates to the meeting; a meeting fetched without a caller in mind reads as the owner's. */
    role: "role" in meeting ? meeting.role : "owner",
    title: meeting.title,
    status: meeting.status,
    /** What the meeting is transcribing while it runs on this server, otherwise null. */
    source,
    startedAt: meeting.startedAt?.toISOString() ?? null,
    endedAt: meeting.endedAt?.toISOString() ?? null,
    createdAt: meeting.createdAt.toISOString(),
  };
}

/** Mounts the meeting lifecycle API: start, end, list, and the live-audio ingest socket. */
export function mountMeetingRoutes(
  app: Hono<{ Variables: StreamVariables & Record<string, unknown> }>,
  deps: MeetingApiDeps,
  sockets?: SocketRegistry,
): void {
  app.get("/meetings", async (c) => {
    const raw = c.req.query("limit");
    const limit = raw === undefined ? 50 : /^\d{1,4}$/.test(raw) ? Number(raw) : 0;
    if (limit < 1 || limit > MAX_LIST) return c.json({ error: `limit must be 1 to ${MAX_LIST}` }, 400);
    const meetings = await deps.list(currentUserId(c), limit);
    return c.json({ meetings: meetings.map((m) => meetingJson(m, deps.sourceOf(m.id))) });
  });

  app.get("/meetings/:id", async (c) => {
    const id = c.req.param("id");
    const meeting = UUID.test(id) ? await deps.get(currentUserId(c), id) : null;
    if (!meeting) return c.json({ error: "not found" }, 404);
    return c.json(meetingJson(meeting, deps.sourceOf(id)));
  });

  app.post("/meetings", async (c) => {
    const body = startBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body", issues: body.error.issues }, 400);
    try {
      const meeting = await deps.start(currentUserId(c), body.data);
      return c.json(meetingJson(meeting, body.data.source), 201);
    } catch (error) {
      if (error instanceof MeetingAlreadyLiveError) {
        return c.json({ error: "a meeting is already live", meetingId: error.meetingId }, 409);
      }
      if (error instanceof MeetingRequestError) {
        return c.json({ error: error.message }, error.kind === "invalid" ? 400 : 503);
      }
      throw error;
    }
  });

  app.post("/meetings/:id/end", async (c) => {
    const id = c.req.param("id");
    const meeting = UUID.test(id) ? await deps.end(currentUserId(c), id) : null;
    if (!meeting) return c.json({ error: "not found" }, 404);
    return c.json(meetingJson(meeting, deps.sourceOf(id)));
  });

  app.get(
    "/meetings/:id/audio",
    async (c, next) => {
      const id = c.req.param("id");
      const userId = currentUserId(c);
      const opened = UUID.test(id) ? await deps.openAudio(userId, id) : ({ error: "not_found" } as const);
      if ("error" in opened) {
        const [status, message] = AUDIO_REFUSALS[opened.error];
        return c.json({ error: message }, status);
      }
      c.set("audioMeetingId", id);
      c.set("audioUserId", userId);
      c.set("audioInput", opened.input);
      await next();
    },
    upgradeWebSocket((c) => {
      const id = c.get("audioMeetingId");
      const userId = c.get("audioUserId");
      const input = c.get("audioInput");
      let forget = () => {};
      return {
        onOpen(_event, ws) {
          forget = sockets?.add(id, userId, { close: (code, reason) => ws.close(code, reason) }) ?? forget;
        },
        async onMessage(event, ws) {
          const chunk = await toBytes(event.data);
          // The input ends with the meeting, or when this member is dropped or goes idle.
          if (chunk && !input.push(chunk)) ws.close(1000, "audio ended");
        },
        onClose() {
          forget();
        },
        onError() {
          forget();
        },
      };
    }),
  );
}

const AUDIO_REFUSALS = {
  not_found: [404, "not found"],
  not_live: [409, "meeting is not taking live audio"],
  full: [409, "meeting has no room for another microphone"],
  busy: [409, "your microphone is in use in another meeting"],
} as const;

async function toBytes(data: unknown): Promise<Uint8Array | null> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return null;
}
