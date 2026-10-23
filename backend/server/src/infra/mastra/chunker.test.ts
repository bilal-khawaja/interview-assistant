import { describe, expect, test } from "bun:test";
import { SAMPLE_TEXT } from "../../constants/rag";
import { Chunker } from "./chunker";

describe("Chunker", () => {
  test("splits text into chunks no longer than the size", async () => {
    const text = "Sentence one is here. ".repeat(60);
    const chunks = await new Chunker(100).split(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100);
  });

  test("keeps all content when there is no overlap", async () => {
    const chunks = await new Chunker(64).split(SAMPLE_TEXT);
    const words = (value: string) => value.split(/\s+/).filter(Boolean).join(" ");
    expect(words(chunks.join(" "))).toBe(words(SAMPLE_TEXT));
  });

  test("short text becomes one chunk", async () => {
    expect(await new Chunker(256).split("hello world")).toEqual(["hello world"]);
  });

  test("rejects a non-positive chunk size", () => {
    expect(() => new Chunker(0)).toThrow("chunkSize must be a positive integer");
  });
});
