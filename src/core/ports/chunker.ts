export interface Chunker {
  split(text: string): Promise<string[]>;
}
