import type { TokenUsage } from "../domain/telemetry";

export type EmbeddingResult = {
  vectors: number[][];
  usage: TokenUsage;
};

export interface Embedder {
  embed(texts: string[]): Promise<EmbeddingResult>;
}
