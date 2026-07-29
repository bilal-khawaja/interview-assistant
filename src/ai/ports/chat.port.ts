import type { ChatMessage } from '../../types/chat-message.model';

/**
 * Outbound port. Application/service layer depends only on this contract,
 * never on a concrete provider SDK.
 */
export interface ChatPort {
  complete(messages: ChatMessage[]): Promise<string>;
  stream(messages: ChatMessage[]): AsyncIterable<string>;
}

export interface ChatPortFactory {
  create(model: string, apiKey: string): ChatPort;
}
