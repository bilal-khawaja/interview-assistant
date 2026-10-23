export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;
export const ANSWER_MODEL = "gpt-4.1-nano";
export const AGENT_MODEL = "gpt-4.1-nano";
export const CHAT_MODEL = "gpt-4.1-nano";

/** US dollars per million tokens. One dollar per million tokens is one micro-dollar per token. */
export type ModelPricing = { input: number; cachedInput: number; output: number };
export const CHAT_MODEL_PRICING: ModelPricing = { input: 0.1, cachedInput: 0.025, output: 0.4 };
