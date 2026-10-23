import { and, desc, eq, gte, sql } from "drizzle-orm";
import type {
  DocumentChunk,
  RetrievedChunk,
} from "../../core/domain/knowledge";
import type { Database } from "./client";
import { documentChunks } from "./schema";
import type * as Port from "../../core/ports";

export class KnowledgeBase implements Port.KnowledgeBase {
  constructor(private readonly database: Database) {}

  async store(chunks: DocumentChunk[], vectors: number[][]): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const documentId = chunks[0]?.documentId;
      if (documentId !== undefined) {
        await transaction
          .delete(documentChunks)
          .where(
            and(
              eq(documentChunks.documentId, documentId),
              gte(documentChunks.chunkIndex, chunks.length),
            ),
          );
      }
      for (const [index, chunk] of chunks.entries()) {
        const embedding = vectors[index];
        if (!embedding) {
          throw new Error(`Missing embedding for chunk ${index}`);
        }
        await transaction
          .insert(documentChunks)
          .values({
            documentId: chunk.documentId,
            chunkIndex: chunk.chunkIndex,
            content: chunk.content,
            embedding,
          })
          .onConflictDoUpdate({
            target: [documentChunks.documentId, documentChunks.chunkIndex],
            set: { content: chunk.content, embedding },
          });
      }
    });
  }

  async findSimilar(
    queryVector: number[],
    limit: number,
  ): Promise<RetrievedChunk[]> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("limit must be a positive integer");
    }
    if (queryVector.some((value) => !Number.isFinite(value))) {
      throw new Error("Query embedding contains a non-finite value");
    }

    const vectorLiteral = sql.raw(`'[${queryVector.join(",")}]'::vector`);
    const distance = sql<number>`${documentChunks.embedding} <=> ${vectorLiteral}`;
    const similarity = sql<number>`1 - (${distance})`;

    const rows = await this.database
      .select({
        documentId: documentChunks.documentId,
        chunkIndex: documentChunks.chunkIndex,
        content: documentChunks.content,
        relevance: similarity,
      })
      .from(documentChunks)
      .orderBy(desc(similarity))
      .limit(limit);
    return rows;
  }
}
