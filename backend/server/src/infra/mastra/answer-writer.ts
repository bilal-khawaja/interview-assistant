import type { Agent } from "@mastra/core/agent";
import type { RetrievedChunk } from "../../core/domain/knowledge";
import type * as Port from "../../core/ports";

type AnswerAgent = Pick<Agent, "stream">;

export class AnswerWriter implements Port.AnswerWriter {
  constructor(private readonly agent: AnswerAgent) {}

  write(question: string, evidence: RetrievedChunk[]): Port.AnswerStream {
    const context = evidence
      .map((chunk) => `[chunk ${chunk.chunkIndex}] ${chunk.content}`)
      .join("\n\n");
    const output = this.agent.stream(
      `Context:\n${context}\n\nQuestion: ${question}`,
    );

    return {
      tokens: (async function* () {
        yield* (await output).textStream;
      })(),
      async usage() {
        const usage = await (await output).usage;
        const inputTokens = usage.inputTokens ?? 0;
        const outputTokens = usage.outputTokens ?? 0;
        return {
          inputTokens,
          outputTokens,
          totalTokens: usage.totalTokens ?? inputTokens + outputTokens,
        };
      },
    };
  }
}
