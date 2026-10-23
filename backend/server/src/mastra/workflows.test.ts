import { describe, expect, test } from "bun:test";
import type { DocumentChunk, RetrievedChunk } from "../core/domain/knowledge";
import type * as Port from "../core/ports";
import { createIngestWorkflow, createRetrieveWorkflow } from "./workflows";

function fakes() {
  const stored: { chunks: DocumentChunk[]; vectors: number[][] }[] = [];
  const embedded: string[][] = [];
  const searches: { vector: number[]; limit: number }[] = [];

  const chunker: Port.Chunker = {
    split: async (text) => text.split("|").filter(Boolean),
  };
  const embedder: Port.Embedder = {
    embed: async (texts) => {
      embedded.push(texts);
      return { vectors: texts.map((text) => [text.length, 1]), usage: {} };
    },
  };
  const knowledgeBase: Port.KnowledgeBase = {
    store: async (chunks, vectors) => {
      stored.push({ chunks, vectors });
    },
    findSimilar: async (vector, limit): Promise<RetrievedChunk[]> => {
      searches.push({ vector, limit });
      return [{ documentId: "d", chunkIndex: 0, content: "hit", relevance: 0.5 }];
    },
  };
  return { chunker, embedder, knowledgeBase, stored, embedded, searches };
}

describe("ingest workflow", () => {
  test("chunks, embeds and stores with sequential chunk indexes", async () => {
    const f = fakes();
    const run = await createIngestWorkflow(f).createRun();
    const result = await run.start({
      inputData: { documentId: "doc", text: "aa|bbb|c" },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.result.chunks).toEqual([
      { documentId: "doc", chunkIndex: 0, content: "aa" },
      { documentId: "doc", chunkIndex: 1, content: "bbb" },
      { documentId: "doc", chunkIndex: 2, content: "c" },
    ]);
    expect(f.embedded).toEqual([["aa", "bbb", "c"]]);
    expect(f.stored).toHaveLength(1);
    expect(f.stored[0]?.vectors).toEqual([[2, 1], [3, 1], [1, 1]]);
  });

  test("stores nothing for empty text", async () => {
    const f = fakes();
    const run = await createIngestWorkflow(f).createRun();
    const result = await run.start({ inputData: { documentId: "d", text: "" } });

    expect(result.status).toBe("success");
    expect(f.stored).toEqual([]);
  });

  test("fails when the embedder returns the wrong number of vectors", async () => {
    const f = fakes();
    f.embedder.embed = async () => ({ vectors: [[1]], usage: {} });
    const run = await createIngestWorkflow(f).createRun();
    const result = await run.start({
      inputData: { documentId: "d", text: "a|b" },
    });

    expect(result.status).toBe("failed");
    expect(f.stored).toEqual([]);
  });
});

describe("retrieve workflow", () => {
  test("embeds the question and searches with the default limit", async () => {
    const f = fakes();
    const run = await createRetrieveWorkflow(f).createRun();
    const result = await run.start({ inputData: { question: "hello" } });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.result.passages).toHaveLength(1);
    expect(f.embedded).toEqual([["hello"]]);
    expect(f.searches).toEqual([{ vector: [5, 1], limit: 3 }]);
  });

  test("passes an explicit limit through", async () => {
    const f = fakes();
    const run = await createRetrieveWorkflow(f).createRun();
    await run.start({ inputData: { question: "q", limit: 7 } });

    expect(f.searches[0]?.limit).toBe(7);
  });

  test("fails when no query embedding comes back", async () => {
    const f = fakes();
    f.embedder.embed = async () => ({ vectors: [], usage: {} });
    const run = await createRetrieveWorkflow(f).createRun();
    const result = await run.start({ inputData: { question: "q" } });

    expect(result.status).toBe("failed");
    expect(f.searches).toEqual([]);
  });
});
