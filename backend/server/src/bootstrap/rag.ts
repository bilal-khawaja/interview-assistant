import { DEFAULT_SEARCH_LIMIT } from "../constants/rag";
import type { DocumentChunk, RetrievedChunk } from "../core/domain/knowledge";
import type { TokenUsage } from "../core/domain/telemetry";
import { createDatabase } from "../infra/database/client";
import { KnowledgeBase } from "../infra/database/knowledge-base";
import { AnswerWriter } from "../infra/mastra/answer-writer";
import { Chunker } from "../infra/mastra/chunker";
import { Embedder } from "../infra/openai/embedder";
import { PdfReader } from "../infra/pdfjs/pdf-reader";
import { createMastra } from "../mastra";
import { createAnswererAgent } from "../mastra/agents";
import { createIngestWorkflow, createRetrieveWorkflow } from "../mastra/workflows";

export function createRag() {
  const store = createDatabase();
  const embedder = new Embedder();
  const knowledgeBase = new KnowledgeBase(store.db);
  const mastra = createMastra({
    agents: { answerer: createAnswererAgent() },
    workflows: {
      ingest: createIngestWorkflow({
        chunker: new Chunker(),
        embedder,
        knowledgeBase,
      }),
      retrieve: createRetrieveWorkflow({ embedder, knowledgeBase }),
    },
  });
  const answerWriter = new AnswerWriter(mastra.getAgent("answerer"));

  return {
    pdfReader: new PdfReader(),

    async ingest(documentId: string, text: string): Promise<DocumentChunk[]> {
      const run = await mastra.getWorkflow("ingest").createRun();
      const result = await run.start({ inputData: { documentId, text } });
      if (result.status !== "success") {
        throw new Error(`Ingest failed: ${result.status}`, {
          cause: "error" in result ? result.error : undefined,
        });
      }
      return result.result.chunks;
    },

    async retrieve(
      question: string,
      limit = DEFAULT_SEARCH_LIMIT,
    ): Promise<RetrievedChunk[]> {
      const run = await mastra.getWorkflow("retrieve").createRun();
      const result = await run.start({ inputData: { question, limit } });
      if (result.status !== "success") {
        throw new Error(`Retrieve failed: ${result.status}`, {
          cause: "error" in result ? result.error : undefined,
        });
      }
      return result.result.passages;
    },

    async answer(
      question: string,
      evidence: RetrievedChunk[],
      onToken: (token: string) => void,
    ): Promise<TokenUsage> {
      const answer = answerWriter.write(question, evidence);
      for await (const token of answer.tokens) {
        onToken(token);
      }
      return answer.usage();
    },

    async close(): Promise<void> {
      await mastra.observability?.flush?.();
      await mastra.shutdown();
      await store.sql.close();
    },
  };
}
