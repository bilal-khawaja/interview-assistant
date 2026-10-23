import type { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { z } from "zod";
import type { ChatHost } from "../chat/host";
import type { ChatRunner } from "../chat/runner";
import { InboxIdConflictError } from "../db/repositories/chat-inbox.repository";
import type { ChatMessageRepository } from "../db/repositories/chat-message.repository";
import type { ChatRepository } from "../db/repositories/meeting.repository";
import type { ChatMessage } from "../db/schema";
import { INBOX_MODES } from "../db/schema";
import { runChatStream, messageFrame, type ChatStreamDeps } from "./chat-stream";
import { sinkFor } from "./sink";

export type ChatApiDeps = ChatStreamDeps & {
  runner: Pick<ChatRunner, "submit" | "open">;
  host: Pick<ChatHost, "start">;
  chats: Pick<ChatRepository, "create" | "findInMeeting">;
  messages: Pick<ChatMessageRepository, "head" | "listAfter">;
};

export const MAX_MESSAGE_CHARS = 8_000;
const DEFAULT_PAGE = 100;
const MAX_PAGE = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const postBody = z.object({
  /** The client's id for this message. Re-sending the same id never creates a second message. */
  messageId: z.uuid().optional(),
  mode: z.enum(INBOX_MODES).default("followup"),
  text: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
});

const createBody = z.object({ title: z.string().trim().max(200).default("") });

type ChatVariables = { meetingId: string; chatId: string; after: number };

/** Mounts the chat API on an app whose Variables include meetingId, chatId and after. */
export function mountChatRoutes(
  app: Hono<{ Variables: ChatVariables & Record<string, unknown> }>,
  deps: ChatApiDeps,
  meetingExists: (id: string) => Promise<boolean>,
): void {
  app.post("/meetings/:id/chats", async (c) => {
    const meetingId = c.req.param("id");
    if (!UUID.test(meetingId) || !(await meetingExists(meetingId))) return c.json({ error: "not found" }, 404);
    const body = createBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid body", issues: body.error.issues }, 400);
    const chat = await deps.chats.create(meetingId, body.data.title);
    await deps.runner.open(chat.id);
    deps.host.start(meetingId, chat.id);
    return c.json({ id: chat.id, meetingId, title: chat.title }, 201);
  });

  app.post("/meetings/:id/chats/:chatId/messages", async (c) => {
    const found = await findChat(c.req.param("id"), c.req.param("chatId"));
    if (!found) return c.json({ error: "not found" }, 404);
    const body = postBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid body", issues: body.error.issues }, 400);

    const messageId = body.data.messageId ?? crypto.randomUUID();
    try {
      const { created } = await deps.runner.submit(found.chatId, messageId, body.data.mode, body.data.text);
      return c.json({ messageId, created }, created ? 202 : 200);
    } catch (error) {
      if (error instanceof InboxIdConflictError) return c.json({ error: "messageId already used" }, 409);
      throw error;
    }
  });

  app.get("/meetings/:id/chats/:chatId/messages", async (c) => {
    const found = await findChat(c.req.param("id"), c.req.param("chatId"));
    if (!found) return c.json({ error: "not found" }, 404);
    const after = parseCount(c.req.query("after"), 0);
    const limit = parseCount(c.req.query("limit"), DEFAULT_PAGE);
    if (after === null || limit === null || limit < 1 || limit > MAX_PAGE) {
      return c.json({ error: `after must be >= 0 and limit between 1 and ${MAX_PAGE}` }, 400);
    }
    const [rows, head] = await Promise.all([
      deps.messages.listAfter(found.chatId, after, limit),
      deps.messages.head(found.chatId),
    ]);
    return c.json({ messages: rows.map(messageJson), head });
  });

  app.get(
    "/meetings/:id/chats/:chatId/stream",
    async (c, next) => {
      const found = await findChat(c.req.param("id"), c.req.param("chatId"));
      if (!found) return c.json({ error: "not found" }, 404);
      const after = parseCount(c.req.query("after"), 0);
      if (after === null) return c.json({ error: "after must be a non-negative integer" }, 400);
      c.set("meetingId", found.meetingId);
      c.set("chatId", found.chatId);
      c.set("after", after);
      await next();
    },
    upgradeWebSocket((c) => {
      const meetingId = c.get("meetingId");
      const chatId = c.get("chatId");
      const after = c.get("after");
      const abort = new AbortController();
      return {
        onOpen(_event, ws) {
          void runChatStream(deps, sinkFor(ws), meetingId, chatId, after, abort.signal);
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

  async function findChat(meetingId: string, chatId: string) {
    if (!UUID.test(meetingId) || !UUID.test(chatId)) return null;
    const chat = await deps.chats.findInMeeting(meetingId, chatId);
    return chat ? { meetingId, chatId } : null;
  }
}

/** Same shape as the stream's message frames, minus the frame type. */
function messageJson(message: ChatMessage) {
  const { type: _type, ...rest } = messageFrame(message);
  return rest;
}

function parseCount(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined) return fallback;
  return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}
