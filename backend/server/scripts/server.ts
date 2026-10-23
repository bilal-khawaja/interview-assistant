import { websocket } from "hono/bun";
import { ChatHost } from "../src/chat/host";
import { KeyedCoordinator } from "../src/chat/keyed-coordinator";
import { ChatRunner } from "../src/chat/runner";
import { createDb } from "../src/db/client";
import { ChatMessageRepository } from "../src/db/repositories/chat-message.repository";
import { CursorRepository } from "../src/db/repositories/cursor.repository";
import { ChatRepository, MeetingRepository } from "../src/db/repositories/meeting.repository";
import { MeetingParticipantRepository } from "../src/db/repositories/participant.repository";
import { SegmentRepository } from "../src/db/repositories/segment.repository";
import { env } from "../src/env";
import { tryAdvisoryLock } from "../src/db/locks";
import { MastraChatAgent, MastraChatSummarizer } from "../src/infra/mastra/chat-agent";
import { TranscriptConsumer } from "../src/log/consumer";
import { CursorService } from "../src/log/cursor";
import { PRODUCER_LOCK } from "../src/log/append";
import { createChatAgent, createSummarizerAgent } from "../src/mastra/agents";
import { endOrphanedMeetings, startOrphanSweeper } from "../src/log/sweep";
import { PgWakeBridge, WakeHub } from "../src/log/wake";
import { createApp } from "../src/server/app";

const { db, sql, close } = createDb();
const sweepDeps = {
  meetings: new MeetingRepository(db),
  tryLock: (id: string) => tryAdvisoryLock(sql, PRODUCER_LOCK, id),
};
const orphaned = await endOrphanedMeetings(sweepDeps);
if (orphaned.length) console.log(`SERVER ended ${orphaned.length} orphaned live meeting(s)`);
const stopSweeper = startOrphanSweeper(sweepDeps, 30_000, (ended, error) => {
  if (error) console.error("SERVER orphan sweep failed", error);
  else if (ended.length) console.log(`SERVER ended ${ended.length} orphaned live meeting(s)`);
});

const hub = new WakeHub();
const bridge = new PgWakeBridge(sql, hub);
await bridge.start();

const chatHub = new WakeHub();
const chatBridge = new PgWakeBridge(sql, chatHub, "chat_messages");
await chatBridge.start();

const segments = new SegmentRepository(db);
const chats = new ChatRepository(db);
const chatMessages = new ChatMessageRepository(db);
const runner = new ChatRunner({
  db,
  coordinator: new KeyedCoordinator(),
  agent: new MastraChatAgent(createChatAgent()),
  summarizer: new MastraChatSummarizer(createSummarizerAgent()),
  onError: (error, chatId) => console.error(`SERVER chat ${chatId} turn failed`, error),
});
const cursors = new CursorService({ chats, cursors: new CursorRepository(db), segments });
const host = new ChatHost({
  runner,
  consumer: new TranscriptConsumer({
    hub,
    readAfter: (m, after, limit) => segments.readAfter(m, after, limit),
    sql,
    cursors,
  }),
  cursors,
  onError: (error, chatId) => console.error(`SERVER chat ${chatId} consumer failed`, error),
  onOutage: (error, attempt, chatId) =>
    console.error(`SERVER chat ${chatId} DB unreachable (attempt ${attempt})`, error instanceof Error ? error.message : error),
});
await runner.recover();
for (const chat of await chats.listConversational()) host.start(chat.meetingId, chat.id);

const app = createApp({
  meetings: new MeetingRepository(db),
  segments,
  participants: new MeetingParticipantRepository(db),
  hub,
  heartbeatMs: 15_000,
  maxBufferedBytes: 1_000_000,
  chat: {
    runner,
    host,
    chats,
    messages: chatMessages,
    hub: chatHub,
    heartbeatMs: 15_000,
    maxBufferedBytes: 1_000_000,
  },
});

const server = Bun.serve({ port: env.PORT, fetch: app.fetch, websocket });
console.log(`SERVER pid=${process.pid} listening on http://localhost:${server.port}`);

const shutdown = async () => {
  stopSweeper();
  await server.stop(true);
  await host.stop();
  await chatBridge.stop();
  await bridge.stop();
  await close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
