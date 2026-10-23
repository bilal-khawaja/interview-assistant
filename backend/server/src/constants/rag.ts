export const CHUNK_SIZE = 256;
export const DEFAULT_SEARCH_LIMIT = 3;

export const DEFAULT_DOCUMENT_ID = "vector-search-introduction";
export const DEFAULT_QUESTION = "What is the main point of this document?";

export const SAMPLE_TEXT = `
  Vector search turns text into numerical representations called embeddings.
  A document is split into focused chunks before embedding so each stored
  vector represents a useful piece of context. At query time, the query is
  embedded with the same model and compared with stored vectors using cosine
  similarity. The highest scoring chunks can then be passed to a language
  model as retrieval-augmented context.
`;
