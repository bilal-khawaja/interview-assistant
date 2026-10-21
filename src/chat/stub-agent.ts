import type { ChatAgent, ChatAgentResult, ChatSummarizer, ChatTurn, SummaryResult } from "./agent";

export type StubAgentOptions = {
  /** Time a call takes; an abort during it rejects like a real model call. */
  delayMs?: number;
  /** Return an error to make the call fail. */
  fail?: (turn: ChatTurn) => Error | null;
  tokensIn?: number;
  tokensOut?: number;
};

/** Deterministic agent for tests and local runs without a model. */
export class StubChatAgent implements ChatAgent {
  readonly calls: ChatTurn[] = [];

  constructor(private readonly options: StubAgentOptions = {}) {}

  async respond(turn: ChatTurn): Promise<ChatAgentResult> {
    this.calls.push(turn);
    await delay(this.options.delayMs ?? 0, turn.signal);
    const error = this.options.fail?.(turn);
    if (error) throw error;

    const usage = {
      tokensIn: this.options.tokensIn ?? 100,
      tokensOut: this.options.tokensOut ?? 20,
    };
    if (turn.trigger === "user") {
      const question = turn.history.findLast((m) => m.role === "user");
      return { text: `re: ${question?.content ?? ""}`, terms: [], usage };
    }
    const first = turn.transcript[0]?.seq;
    const last = turn.transcript.at(-1)?.seq;
    const words = turn.transcript.flatMap((s) => s.text.match(/\b[A-Z][a-z]{3,}\b/g) ?? []);
    return { text: `suggestion for ${first}-${last}`, terms: [...new Set(words)], usage };
  }
}

/** Deterministic summarizer for tests: records its prompts and returns a template-shaped summary. */
export class StubSummarizer implements ChatSummarizer {
  readonly prompts: string[] = [];

  constructor(private readonly options: { fail?: boolean; tokens?: number } = {}) {}

  async summarize(prompt: string): Promise<SummaryResult> {
    this.prompts.push(prompt);
    if (this.options.fail) throw new Error("summarizer down");
    return {
      text: `## Goal\nsummary ${this.prompts.length}\n## Decisions and facts\n## Open questions\n## User requests`,
      usage: { tokensIn: this.options.tokens ?? 50, tokensOut: 10 },
    };
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}
