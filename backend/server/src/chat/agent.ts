import type { ChatMessage, TranscriptSegment } from "../db/schema";

export type ChatTurn = {
  /** transcript: new segments arrived. user: a user message is waiting for a reply. */
  trigger: "transcript" | "user";
  /** Frozen for the epoch: identical across turns so the provider can cache it. */
  system: string;
  /** Changing context (surfaced terms, topic state, transcript) rendered for the prompt, after `system`. */
  dynamic: string;
  /** Oldest first. For a user turn the last entry is the message being answered. */
  history: ChatMessage[];
  /** New segments for a transcript turn; the most recent window for a user turn. */
  transcript: TranscriptSegment[];
  /** Terms this chat has already pointed out. */
  surfacedTerms: string[];
  topicState: Record<string, unknown>;
  /** Aborted when a steering input arrives; stop and throw. */
  signal: AbortSignal;
};

export type ChatUsage = {
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead?: number;
  tokensCacheWrite?: number;
  costMicros?: number;
};

export type ChatAgentResult = {
  /** The message to show, or null when there is nothing worth saying. */
  text: string | null;
  /** Terms the text points out. A suggestion whose terms were all surfaced before is dropped. */
  terms: string[];
  usage: ChatUsage;
};

export type SummaryResult = { text: string; usage: ChatUsage };

/** Port: turns a compaction prompt into a summary. Implemented by an adapter in src/infra. */
export interface ChatSummarizer {
  summarize(prompt: string): Promise<SummaryResult>;
}

/** Port: the model behind a chat. Implemented by an adapter in src/infra. */
export interface ChatAgent {
  respond(turn: ChatTurn): Promise<ChatAgentResult>;
}
