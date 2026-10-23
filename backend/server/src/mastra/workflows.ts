import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { DEFAULT_SEARCH_LIMIT } from "../constants/rag";
import type { DocumentChunk, RetrievedChunk } from "../core/domain/knowledge";
import type * as Port from "../core/ports";

const chunkSchema = z.object({
  documentId: z.string(),
  chunkIndex: z.number().int(),
  content: z.string(),
});

const passageSchema = chunkSchema.extend({ relevance: z.number() });

export type IngestDependencies = {
  chunker: Port.Chunker;
  embedder: Port.Embedder;
  knowledgeBase: Port.KnowledgeBase;
};

export type RetrieveDependencies = {
  embedder: Port.Embedder;
  knowledgeBase: Port.KnowledgeBase;
};

export function createIngestWorkflow(deps: IngestDependencies) {
  const chunkDocument = createStep({
    id: "chunk-document",
    inputSchema: z.object({ documentId: z.string(), text: z.string() }),
    outputSchema: z.object({
      documentId: z.string(),
      passages: z.array(z.string()),
    }),
    execute: async ({ inputData }) => ({
      documentId: inputData.documentId,
      passages: await deps.chunker.split(inputData.text),
    }),
  });

  const embedChunks = createStep({
    id: "embed-document-chunks",
    inputSchema: chunkDocument.outputSchema,
    outputSchema: z.object({
      documentId: z.string(),
      passages: z.array(z.string()),
      vectors: z.array(z.array(z.number())),
    }),
    execute: async ({ inputData }) => {
      const { documentId, passages } = inputData;
      const { vectors } = await deps.embedder.embed(passages);
      if (vectors.length !== passages.length) {
        throw new Error("Each document chunk must have one embedding");
      }
      return { documentId, passages, vectors };
    },
  });

  const persistChunks = createStep({
    id: "persist-chunks-and-vectors",
    inputSchema: embedChunks.outputSchema,
    outputSchema: z.object({ chunks: z.array(chunkSchema) }),
    execute: async ({ inputData }) => {
      const chunks: DocumentChunk[] = inputData.passages.map(
        (content, chunkIndex) => ({
          documentId: inputData.documentId,
          chunkIndex,
          content,
        }),
      );
      if (chunks.length > 0) {
        await deps.knowledgeBase.store(chunks, inputData.vectors);
      }
      return { chunks };
    },
  });

  return createWorkflow({
    id: "ingest-document",
    inputSchema: chunkDocument.inputSchema,
    outputSchema: persistChunks.outputSchema,
  })
    .then(chunkDocument)
    .then(embedChunks)
    .then(persistChunks)
    .commit();
}

export function createRetrieveWorkflow(deps: RetrieveDependencies) {
  const embedQuery = createStep({
    id: "embed-query",
    inputSchema: z.object({
      question: z.string(),
      limit: z.number().int().positive().optional(),
    }),
    outputSchema: z.object({
      queryVector: z.array(z.number()),
      limit: z.number().int().positive(),
    }),
    execute: async ({ inputData }) => {
      const { vectors } = await deps.embedder.embed([inputData.question]);
      const queryVector = vectors[0];
      if (!queryVector) {
        throw new Error("The embedding provider returned no query embedding");
      }
      return { queryVector, limit: inputData.limit ?? DEFAULT_SEARCH_LIMIT };
    },
  });

  const searchSimilar = createStep({
    id: "pgvector-cosine-retrieval",
    inputSchema: embedQuery.outputSchema,
    outputSchema: z.object({ passages: z.array(passageSchema) }),
    execute: async ({ inputData }) => ({
      passages: await deps.knowledgeBase.findSimilar(
        inputData.queryVector,
        inputData.limit,
      ),
    }),
  });

  return createWorkflow({
    id: "retrieve-passages",
    inputSchema: embedQuery.inputSchema,
    outputSchema: searchSimilar.outputSchema,
  })
    .then(embedQuery)
    .then(searchSimilar)
    .commit();
}

export type { DocumentChunk, RetrievedChunk };
