import {
  BUDGET_EXHAUSTED_NOTICE,
  CHAT_HISTORY_LIMIT,
  CHAT_TRANSCRIPT_WINDOW,
  DEFAULT_CHAT_SYSTEM_PROMPT,
  DEFAULT_CHAT_TOKEN_LIMIT,
  TURN_FAILED_NOTICE,
} from "../constants/chat";
import type { Database, Executor } from "../db/client";
import { ChatBudgetRepository } from "../db/repositories/chat-budget.repository";
import { ChatInboxRepository } from "../db/repositories/chat-inbox.repository";
import { ChatMessageRepository } from "../db/repositories/chat-message.repository";
import { ChatSurfacedTermsRepository } from "../db/repositories/chat-surfaced-terms.repository";
import { CursorRepository } from "../db/repositories/cursor.repository";
import { SegmentRepository } from "../db/repositories/segment.repository";
import { type ChatMessage, type InboxMode, type TranscriptSegment } from "../db/schema";
import type { ChatAgent, ChatAgentResult, ChatSummarizer, ChatUsage } from "./agent";
import { ChatCompactor, type CompactionConfig } from "./compaction";
import { ChatContextBuilder } from "./context";
import { derivedId } from "./ids";
import type { KeyedCoordinator } from "./keyed-coordinator";
import { ChatInput } from "./session/input";

export class TurnAbortedError extends Error {
  constructor(readonly chatId: string) {
    super(`turn for chat ${chatId} was stopped by a steering input`);
    this.name = "TurnAbortedError";
  }
}

export type RunnerDeps = {
  db: Database;
  coordinator: KeyedCoordinator;
  agent: ChatAgent;
  /** Without a summarizer the chat is never compacted. */
  summarizer?: ChatSummarizer;
  compaction?: CompactionConfig;
  tokenLimit?: number;
  historyLimit?: number;
  transcriptWindow?: number;
  systemPrompt?: string;
  onError?: (error: unknown, chatId: string) => void;
};

export type Submitted = {
  created: boolean;
  /** Settles once the chat has worked through its pending inputs. Safe to ignore. */
  done: Promise<void>;
};

/** The model call itself failed, as opposed to the database or the runner. */
class AgentCallError extends Error {
  constructor(override readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "AgentCallError";
  }
}

/**
 * Runs a chat's turns. Every turn for a chat goes through the coordinator, so the chat does
 * one thing at a time: answer one user message, or react to one batch of transcript segments.
 *
 * User inputs are answered one turn per message. Each round promotes the most urgent input
 * (steers before follow-ups) and answers it, so a steer that arrives while follow-ups are
 * queued runs ahead of them. A steer also aborts the turn in flight. An aborted user turn
 * leaves its message unanswered in the history; the steer's turn sees it as context.
 *
 * Every turn commits in one transaction: the message, the budget charge, the surfaced terms
 * and, for transcript turns, the cursor. A crash before the commit repeats the turn; after
 * it, nothing is repeated.
 */
export class ChatRunner {
  readonly input: ChatInput;
  private readonly inflight = new Map<string, AbortController>();
  private readonly context: ChatContextBuilder;
  private readonly compactor: ChatCompactor | null;
  private readonly tokenLimit: number;

  constructor(private readonly deps: RunnerDeps) {
    this.tokenLimit = deps.tokenLimit ?? DEFAULT_CHAT_TOKEN_LIMIT;
    this.compactor = deps.summarizer ? new ChatCompactor(deps.db, deps.summarizer, deps.compaction) : null;
    this.context = new ChatContextBuilder(deps.db, {
      systemPrompt: deps.systemPrompt ?? DEFAULT_CHAT_SYSTEM_PROMPT,
      historyLimit: deps.historyLimit ?? CHAT_HISTORY_LIMIT,
      transcriptWindow: deps.transcriptWindow ?? CHAT_TRANSCRIPT_WINDOW,
    });
    this.input = new ChatInput({
      db: deps.db,
      coordinator: deps.coordinator,
      onSteer: (chatId) => this.steer(chatId),
      onError: deps.onError,
    });
  }

  /** Creates the chat's budget and first context epoch. Safe to call repeatedly. */
  open(chatId: string): Promise<void> {
    return this.ensureState(chatId);
  }

  /** Stops the turn currently running for the chat, if any. */
  steer(chatId: string): void {
    this.inflight.get(chatId)?.abort();
  }

  /** Records the input and, in the background, works through the chat's pending inputs. */
  async submit(
    chatId: string,
    messageId: string,
    mode: InboxMode,
    text: string,
  ): Promise<Submitted> {
    const { created } = await this.input.admit(chatId, messageId, mode, text);
    const done = this.processInputs(chatId);
    done.catch((error) => this.deps.onError?.(error, chatId));
    return { created, done };
  }

  processInputs(chatId: string): Promise<void> {
    return this.deps.coordinator.run(chatId, async () => {
      for (;;) {
        const target = (await this.input.promoteNext(chatId)) ?? (await this.unanswered(chatId));
        if (!target) return;
        await this.userTurn(chatId);
      }
    });
  }

  /** Startup recovery: pick up chats with pending inputs or a user message nobody answered. */
  async recover(): Promise<void> {
    const pending = await new ChatInboxRepository(this.deps.db).allPending();
    const waiting = await new ChatMessageRepository(this.deps.db).chatsAwaitingReply();
    const chatIds = new Set([...pending.map((item) => item.chatId), ...waiting]);
    await Promise.all([...chatIds].map((chatId) => this.processInputs(chatId)));
  }

  /**
   * One transcript turn. Throws TurnAbortedError if a steer stopped it (the consumer
   * redelivers the batch once the steer has run) and rethrows agent errors for the same retry.
   */
  handleTranscript(chatId: string, segments: TranscriptSegment[]): Promise<void> {
    return this.deps.coordinator.run(chatId, async () => {
      const last = segments.at(-1);
      if (!last) return;
      const db = this.deps.db;
      await this.ensureState(chatId);

      if ((await new ChatBudgetRepository(db).remaining(chatId)) <= 0) {
        await db.transaction(async (tx) => {
          await this.noticeOnce(tx, chatId, BUDGET_EXHAUSTED_NOTICE);
          await new CursorRepository(tx).advance(chatId, last.seq);
        });
        return;
      }

      const result = await this.askAgent(chatId, "transcript", segments).catch((error) => {
        throw error instanceof AgentCallError ? error.cause : error;
      });
      if (!result) throw new TurnAbortedError(chatId);

      await db.transaction(async (tx) => {
        const terms = new ChatSurfacedTermsRepository(tx);
        const drafts = result.terms.map((term) => ({ term, firstSeq: last.seq }));
        const fresh = await terms.unseen(chatId, drafts);
        const worthSaying = result.text && (drafts.length === 0 || fresh.length > 0);
        let charge = true;
        if (worthSaying) {
          const { created } = await new ChatMessageRepository(tx).appendOnce(chatId, {
            id: derivedId("suggestion", chatId, last.seq),
            role: "assistant",
            kind: "suggestion",
            content: result.text!,
            transcriptSeq: last.seq,
            ...usageColumns(result.usage),
          });
          charge = created;
          await terms.addMany(chatId, fresh);
        }
        if (charge) await new ChatBudgetRepository(tx).charge(chatId, spent(result.usage), result.usage.costMicros);
        await new CursorRepository(tx).advance(chatId, last.seq);
      });
      await this.compact(chatId);
    });
  }

  /** Runs after a turn has committed. A failure leaves the history as it was and is retried after the next turn. */
  private async compact(chatId: string): Promise<void> {
    try {
      await this.compactor?.compactIfNeeded(chatId);
    } catch (error) {
      this.deps.onError?.(error, chatId);
    }
  }

  /** Answers the newest user message. A steer that aborts the call leaves the message unanswered. */
  private async userTurn(chatId: string): Promise<void> {
    const db = this.deps.db;
    const messages = new ChatMessageRepository(db);
    await this.ensureState(chatId);

    // Another process may have answered while this one waited; then there is nothing to do.
    const [question] = await messages.tail(chatId, 1);
    if (question?.role !== "user") return;

    if ((await new ChatBudgetRepository(db).remaining(chatId)) <= 0) {
      await messages.append(chatId, {
        role: "system",
        kind: "notice",
        content: BUDGET_EXHAUSTED_NOTICE,
      });
      return;
    }

    let result: ChatAgentResult | null;
    try {
      result = await this.askAgent(chatId, "user");
    } catch (error) {
      if (!(error instanceof AgentCallError)) throw error;
      this.deps.onError?.(error.cause, chatId);
      await messages.append(chatId, { role: "system", kind: "notice", content: TURN_FAILED_NOTICE });
      return;
    }
    if (!result) return;

    // A turn must leave something after the user message, or the chat would look unanswered.
    if (!result.text) {
      await messages.append(chatId, { role: "system", kind: "notice", content: TURN_FAILED_NOTICE });
      return;
    }
    const reply = result.text;
    const transcriptSeq = await this.transcriptHead(chatId);
    // The reply's id comes from the question's, so a second process that answered the same
    // question finds this row instead of adding another, and does not charge again.
    await db.transaction(async (tx) => {
      const { created } = await new ChatMessageRepository(tx).appendOnce(chatId, {
        id: derivedId("reply", question.id),
        role: "assistant",
        kind: "reply",
        content: reply,
        transcriptSeq,
        ...usageColumns(result.usage),
      });
      if (created) await new ChatBudgetRepository(tx).charge(chatId, spent(result.usage), result.usage.costMicros);
    });
    await this.compact(chatId);
  }

  /**
   * Calls the agent with the chat's current context. Returns null if a steer aborted the
   * call (its usage is not charged). A failing model call throws AgentCallError.
   */
  private async askAgent(
    chatId: string,
    trigger: "transcript" | "user",
    segments?: TranscriptSegment[],
  ): Promise<ChatAgentResult | null> {
    const context = await this.context.build(chatId, segments);

    const controller = new AbortController();
    this.inflight.set(chatId, controller);
    try {
      const result = await this.deps.agent.respond({
        trigger,
        system: context.system,
        dynamic: context.dynamic,
        history: context.history,
        transcript: context.transcript,
        surfacedTerms: context.surfacedTerms,
        topicState: context.topicState,
        signal: controller.signal,
      });
      return controller.signal.aborted ? null : result;
    } catch (error) {
      if (controller.signal.aborted) return null;
      throw new AgentCallError(error);
    } finally {
      if (this.inflight.get(chatId) === controller) this.inflight.delete(chatId);
    }
  }

  private async unanswered(chatId: string): Promise<ChatMessage | null> {
    const [latest] = await new ChatMessageRepository(this.deps.db).tail(chatId, 1);
    return latest?.role === "user" ? latest : null;
  }

  private async noticeOnce(tx: Executor, chatId: string, text: string) {
    const messages = new ChatMessageRepository(tx);
    const [latest] = await messages.tail(chatId, 1);
    if (latest?.kind === "notice" && latest.content === text) return;
    await messages.append(chatId, { role: "system", kind: "notice", content: text });
  }

  private async ensureState(chatId: string): Promise<void> {
    await new ChatBudgetRepository(this.deps.db).ensure(chatId, this.tokenLimit);
    await this.context.ensure(chatId);
  }

  private async transcriptHead(chatId: string): Promise<number> {
    return new SegmentRepository(this.deps.db).head(await this.context.meetingId(chatId));
  }
}

function spent(usage: ChatUsage): number {
  return usage.tokensIn + usage.tokensOut;
}

function usageColumns(usage: ChatUsage) {
  return {
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    tokensCacheRead: usage.tokensCacheRead ?? 0,
    tokensCacheWrite: usage.tokensCacheWrite ?? 0,
  };
}
