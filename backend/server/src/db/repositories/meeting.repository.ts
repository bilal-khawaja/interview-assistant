import { and, asc, desc, eq, isNotNull, isNull, ne, or, type SQL } from "drizzle-orm";
import type { Executor } from "../client";
import {
  chatBudget,
  chats,
  meetingMembers,
  meetings,
  type Chat,
  type Meeting,
  type MeetingStatus,
} from "../schema";
import { BaseRepository, MutableRepository } from "./base.repository";

export type MeetingRole = "owner" | "participant";
export type AccessibleMeeting = Meeting & { role: MeetingRole };

export class MeetingRepository extends MutableRepository<typeof meetings> {
  constructor(db: Executor) {
    super(db, meetings);
  }

  create(title: string, userId: string): Promise<Meeting> {
    return this.insertOne({ title, userId });
  }

  findById(id: string): Promise<Meeting | null> {
    return this.findOne(eq(meetings.id, id));
  }

  async latest(): Promise<Meeting | null> {
    const rows = await this.findMany({
      orderBy: desc(meetings.createdAt),
      limit: 1,
    });
    return rows[0] ?? null;
  }

  /** The meeting if it exists and belongs to the user; null otherwise, so callers cannot tell the two apart. */
  findOwned(id: string, userId: string): Promise<Meeting | null> {
    return this.findOne(and(eq(meetings.id, id), eq(meetings.userId, userId))!);
  }

  /**
   * The meeting if the user owns it or is an active member; null otherwise, so callers cannot
   * tell a stranger's meeting from a missing one.
   */
  async findAccessible(id: string, userId: string): Promise<AccessibleMeeting | null> {
    const rows = await this.accessible(userId, eq(meetings.id, id), 1);
    return rows[0] ?? null;
  }

  /** Meetings the user owns or has joined, newest first. */
  listAccessible(userId: string, limit = 50): Promise<AccessibleMeeting[]> {
    return this.accessible(userId, undefined, limit);
  }

  private async accessible(userId: string, where: SQL | undefined, limit: number): Promise<AccessibleMeeting[]> {
    const rows = await this.db
      .select({ meeting: meetings })
      .from(meetings)
      .leftJoin(
        meetingMembers,
        and(
          eq(meetingMembers.meetingId, meetings.id),
          eq(meetingMembers.userId, userId),
          isNull(meetingMembers.removedAt),
        ),
      )
      .where(and(where, or(eq(meetings.userId, userId), isNotNull(meetingMembers.id))))
      .orderBy(desc(meetings.createdAt))
      .limit(limit);
    return rows.map(({ meeting }) => ({ ...meeting, role: meeting.userId === userId ? "owner" : "participant" }));
  }

  /** The user's own meetings, newest first. */
  listByUser(userId: string, limit = 50): Promise<Meeting[]> {
    return this.findMany({ where: eq(meetings.userId, userId), orderBy: desc(meetings.createdAt), limit });
  }

  async touchHeartbeat(id: string, at: Date = new Date()): Promise<void> {
    await this.updateWhere(eq(meetings.id, id), { producerHeartbeatAt: at });
  }

  listByStatus(status: MeetingStatus): Promise<Meeting[]> {
    return this.findMany({ where: eq(meetings.status, status) });
  }

  async setStatus(id: string, status: MeetingStatus): Promise<Meeting | null> {
    const current = status === "live" ? await this.findById(id) : null;
    const rows = await this.updateWhere(eq(meetings.id, id), {
      status,
      ...(status === "live"
        ? { startedAt: current?.startedAt ?? new Date(), endedAt: null }
        : {}),
      ...(status === "ended" ? { endedAt: new Date() } : {}),
    });
    return rows[0] ?? null;
  }
}

export class ChatRepository extends BaseRepository<typeof chats> {
  constructor(db: Executor) {
    super(db, chats);
  }

  create(meetingId: string, title = ""): Promise<Chat> {
    return this.insertOne({ meetingId, title });
  }

  findByTitle(meetingId: string, title: string): Promise<Chat | null> {
    return this.findOne(
      and(eq(chats.meetingId, meetingId), eq(chats.title, title))!,
    );
  }

  /** Chats that run a chat session (they have a budget) in meetings that are not over. */
  async listConversational(): Promise<Chat[]> {
    const rows = await this.db
      .select({ chat: chats })
      .from(chats)
      .innerJoin(chatBudget, eq(chatBudget.chatId, chats.id))
      .innerJoin(meetings, eq(meetings.id, chats.meetingId))
      .where(ne(meetings.status, "ended"));
    return rows.map((row) => row.chat);
  }

  /** Oldest first. */
  listByMeeting(meetingId: string): Promise<Chat[]> {
    return this.findMany({ where: eq(chats.meetingId, meetingId), orderBy: asc(chats.createdAt) });
  }

  findInMeeting(meetingId: string, chatId: string): Promise<Chat | null> {
    return this.findOne(
      and(eq(chats.meetingId, meetingId), eq(chats.id, chatId))!,
    );
  }
}
