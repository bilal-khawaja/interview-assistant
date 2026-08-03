import type { ChatMessage } from '../../types/chat-message.model';

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

export interface ChatOptions {
  webSearch?: boolean;
  reasoning?: boolean;
  reasoningEffort?: ReasoningEffort;
}

export interface ChatCompleteResult {
  text: string;
  reasoning?: string;
}

export type ChatStreamChunk = { type: 'text' | 'reasoning'; delta: string };

/**
 * Outbound port. Application/service layer depends only on this contract,
 * never on a concrete provider SDK.
 */
export interface ChatPort {
  complete(messages: ChatMessage[], options?: ChatOptions): Promise<ChatCompleteResult>;
  stream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<ChatStreamChunk>;
}

export interface ChatPortFactory {
  create(model: string, apiKey: string): ChatPort;
}
