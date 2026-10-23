import { embedMany } from "ai";
import { EMBEDDING_MODEL } from "../../constants/models";
import { openai } from "./client";
import type * as Port from "../../core/ports";

export class Embedder implements Port.Embedder {
  async embed(texts: string[]): Promise<Port.EmbeddingResult> {
    if (texts.length === 0) {
      return { vectors: [], usage: {} };
    }

    const result = await embedMany({
      model: openai.embedding(EMBEDDING_MODEL),
      values: texts,
    });
    return {
      vectors: result.embeddings,
      usage: { totalTokens: result.usage.tokens },
    };
  }
}
