import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { ChatContextRepository } from "../db/repositories/chat-context.repository";
import { ChatMessageRepository } from "../db/repositories/chat-message.repository";
import { ChatSurfacedTermsRepository } from "../db/repositories/chat-surfaced-terms.repository";
import { ChatRepository, MeetingRepository } from "../db/repositories/meeting.repository";
import { SegmentRepository } from "../db/repositories/segment.repository";
import { chats, type ChatContext, type ChatMessage, type TranscriptSegment } from "../db/schema";

export type ContextConfig = {
  systemPrompt: string;
  historyLimit: number;
  transcriptWindow: number;
};

/** What a turn needs from the chat's stored state, split into the cacheable and the changing part. */
export type BuiltContext = {
  /** Frozen for the epoch: byte-identical across turns, so the provider can cache it. */
  system: string;
  epoch: number;
  history: ChatMessage[];
  transcript: TranscriptSegment[];
  surfacedTerms: string[];
  topicState: Record<string, unknown>;
  /** Rendered changing part: surfaced terms, topic state, transcript. Goes after the frozen prompt. */
  dynamic: string;
};

/** The frozen prompt may only depend on things that cannot change within an epoch. */
export function buildFrozenPrompt(systemPrompt: string, meetingTitle: string): string {
  const title = meetingTitle.trim();
  return title ? `${systemPrompt}\n\nMeeting: ${title}` : systemPrompt;
}

export async function hashPrompt(prompt: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(prompt));
  return Buffer.from(digest).toString("hex");
}

export function renderDynamicContext(parts: {
  surfacedTerms: string[];
  topicState: Record<string, unknown>;
  transcript: TranscriptSegment[];
}): string {
  const sections: string[] = [];
  if (parts.surfacedTerms.length > 0) {
    sections.push(`Terms already surfaced (do not repeat):\n${parts.surfacedTerms.map((t) => `- ${t}`).join("\n")}`);
  }
  if (Object.keys(parts.topicState).length > 0) {
    sections.push(`Topic state:\n${JSON.stringify(parts.topicState)}`);
  }
  if (parts.transcript.length > 0) {
    const lines = parts.transcript.map((s) => `[${s.seq}] ${s.speakerKey ?? "?"}: ${s.text}`);
    sections.push(`Transcript:\n${lines.join("\n")}`);
  }
  return sections.join("\n\n");
}

/**
 * Per-chat prompt context. The frozen prompt is written once per epoch and read back
 * unchanged on every turn; everything that moves is appended after it by build().
 */
export class ChatContextBuilder {
  constructor(
    private readonly db: Database,
    private readonly config: ContextConfig,
  ) {}

  /** Creates the chat's first epoch if missing. An existing epoch is returned as stored. */
  async ensure(chatId: string): Promise<ChatContext> {
    const contexts = new ChatContextRepository(this.db);
    const existing = await contexts.get(chatId);
    if (existing) return existing;
    const meeting = await new MeetingRepository(this.db).findById(await this.meetingId(chatId));
    const frozenPrompt = buildFrozenPrompt(this.config.systemPrompt, meeting?.title ?? "");
    return contexts.ensure(chatId, { frozenPrompt, promptHash: await hashPrompt(frozenPrompt) });
  }

  /** `segments` overrides the transcript window, e.g. the batch that triggered a transcript turn. */
  async build(chatId: string, segments?: TranscriptSegment[]): Promise<BuiltContext> {
    const context = await this.ensure(chatId);
    const messages = new ChatMessageRepository(this.db);
    // After compaction the history is the latest summary followed by what it did not fold in.
    const recent = (await messages.tail(chatId, this.config.historyLimit + 1)).filter(
      (m) => m.role !== "summary" && m.seq > context.summaryUptoSeq,
    );
    const summary = context.summaryUptoSeq > 0 ? await messages.latestSummary(chatId) : null;
    const history = [...(summary ? [summary] : []), ...recent.slice(-this.config.historyLimit)];
    const surfacedTerms = (await new ChatSurfacedTermsRepository(this.db).list(chatId)).map((row) => row.term);
    const transcript = segments ?? (await this.recentTranscript(chatId));
    const topicState = context.topicState;
    return {
      system: context.frozenPrompt,
      epoch: context.epoch,
      history,
      transcript,
      surfacedTerms,
      topicState,
      dynamic: renderDynamicContext({ surfacedTerms, topicState, transcript }),
    };
  }

  async meetingId(chatId: string): Promise<string> {
    const chat = await new ChatRepository(this.db).findOne(eq(chats.id, chatId));
    if (!chat) throw new Error(`chat ${chatId} not found`);
    return chat.meetingId;
  }

  private async recentTranscript(chatId: string): Promise<TranscriptSegment[]> {
    const segments = new SegmentRepository(this.db);
    const meetingId = await this.meetingId(chatId);
    const head = await segments.head(meetingId);
    return segments.readAfter(meetingId, Math.max(0, head - this.config.transcriptWindow), this.config.transcriptWindow);
  }
}
