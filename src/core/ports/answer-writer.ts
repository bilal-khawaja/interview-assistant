import type { RetrievedChunk } from "../domain/knowledge";
import type { TokenUsage } from "../domain/telemetry";

export type AnswerStream = {
  tokens: AsyncIterable<string>;
  usage(): Promise<TokenUsage>;
};

export interface AnswerWriter {
  write(question: string, evidence: RetrievedChunk[]): AnswerStream;
}
