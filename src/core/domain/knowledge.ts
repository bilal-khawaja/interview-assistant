export type DocumentChunk = {
  documentId: string;
  chunkIndex: number;
  content: string;
};

export type RetrievedChunk = DocumentChunk & {
  relevance: number;
};
