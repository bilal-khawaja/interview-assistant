import type { ChatRepository } from "../db/repositories/meeting.repository";
import type { CursorRepository } from "../db/repositories/cursor.repository";
import type { SegmentRepository } from "../db/repositories/segment.repository";
import { NotFoundError } from "./errors";

export type AttachMode =
  | { kind: "beginning" }
  | { kind: "tail"; tail: number };

export class CursorService {
  constructor(
    private readonly deps: {
      chats: ChatRepository;
      cursors: CursorRepository;
      segments: SegmentRepository;
    },
  ) {}

  async attach(
    meetingId: string,
    chatId: string,
    mode: AttachMode = { kind: "beginning" },
  ): Promise<number> {
    await this.assertChat(meetingId, chatId);
    const existing = await this.deps.cursors.get(chatId);
    if (existing) return existing.lastSeenSeq;

    const head =
      mode.kind === "tail" ? await this.deps.segments.head(meetingId) : 0;
    const initial = mode.kind === "tail" ? Math.max(0, head - mode.tail) : 0;
    return (await this.deps.cursors.ensure(chatId, initial)).lastSeenSeq;
  }

  async position(meetingId: string, chatId: string): Promise<number> {
    await this.assertChat(meetingId, chatId);
    return (await this.deps.cursors.get(chatId))?.lastSeenSeq ?? 0;
  }

  async commit(meetingId: string, chatId: string, seq: number): Promise<number> {
    await this.assertChat(meetingId, chatId);
    return (await this.deps.cursors.advance(chatId, seq)).lastSeenSeq;
  }

  private async assertChat(meetingId: string, chatId: string): Promise<void> {
    if (!(await this.deps.chats.findInMeeting(meetingId, chatId))) {
      throw new NotFoundError();
    }
  }
}
