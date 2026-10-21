import type { DocumentChunk, RetrievedChunk } from "../domain/knowledge";

export interface KnowledgeBase {
  store(chunks: DocumentChunk[], vectors: number[][]): Promise<void>;
  findSimilar(queryVector: number[], limit: number): Promise<RetrievedChunk[]>;
}
