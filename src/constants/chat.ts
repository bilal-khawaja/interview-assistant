export const DEFAULT_CHAT_TOKEN_LIMIT = 200_000;
/** Newest chat messages shown to the model until compaction replaces older ones. */
export const CHAT_HISTORY_LIMIT = 40;
/** Newest transcript segments shown to the model when it answers a user message. */
export const CHAT_TRANSCRIPT_WINDOW = 30;

/** Compact once this many messages (or this many estimated tokens) sit after the last summary. */
export const CHAT_COMPACT_AFTER_MESSAGES = 30;
export const CHAT_COMPACT_AFTER_TOKENS = 12_000;
/** Newest messages left verbatim when older ones are folded into a summary. */
export const CHAT_COMPACT_KEEP_MESSAGES = 8;

export const DEFAULT_CHAT_SYSTEM_PROMPT =
  "You assist a participant during a live meeting. Use the transcript excerpts to answer questions " +
  "and to point out useful terms or topics. Never repeat a term already listed as surfaced.";

export const BUDGET_EXHAUSTED_NOTICE = "This chat has used its token budget, so I can't respond any more.";
export const TURN_FAILED_NOTICE = "Something went wrong while answering. Please try again.";
