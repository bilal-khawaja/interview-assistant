import type { ChatMessage } from '../../types/chat-message.model';
import type { ChatCompleteResult, ChatOptions, ChatPortFactory, ChatStreamChunk } from '../ports/chat.port';

export class AiChatService {
  constructor(private readonly portFactory: ChatPortFactory) {}

  async complete(model: string, apiKey: string, messages: ChatMessage[], options?: ChatOptions): Promise<ChatCompleteResult> {
    const port = this.portFactory.create(model, apiKey);
    return port.complete(messages, options);
  }

  stream(model: string, apiKey: string, messages: ChatMessage[], options?: ChatOptions): AsyncIterable<ChatStreamChunk> {
    const port = this.portFactory.create(model, apiKey);
    return port.stream(messages, options);
  }
}
