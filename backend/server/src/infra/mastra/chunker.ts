import { MDocument } from "@mastra/rag";
import { CHUNK_SIZE } from "../../constants/rag";
import type * as Port from "../../core/ports";

export class Chunker implements Port.Chunker {
  constructor(private readonly chunkSize = CHUNK_SIZE) {
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
      throw new Error("chunkSize must be a positive integer");
    }
  }

  async split(text: string): Promise<string[]> {
    const chunks = await MDocument.fromText(text).chunk({
      strategy: "recursive",
      maxSize: this.chunkSize,
      overlap: 0,
    });
    return chunks.map((chunk) => chunk.text);
  }
}
