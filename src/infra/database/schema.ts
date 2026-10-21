import {
  index,
  integer,
  pgTable,
  text,
  unique,
  vector,
} from "drizzle-orm/pg-core";
import { EMBEDDING_DIMENSIONS } from "../../constants/models";

export const documentChunks = pgTable(
  "document_chunks",
  {
    id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
    documentId: text("document_id").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", {
      dimensions: EMBEDDING_DIMENSIONS,
    }).notNull(),
  },
  (table) => [
    unique("document_chunk_identity").on(
      table.documentId,
      table.chunkIndex,
    ),
    index("document_chunks_embedding_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
  ],
);

export type DocumentChunkRow = typeof documentChunks.$inferSelect;
export type NewDocumentChunk = typeof documentChunks.$inferInsert;
