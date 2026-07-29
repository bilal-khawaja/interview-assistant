import type { ChatMessage } from '../../types/chat-message.model';
import type { ChatPortFactory } from '../ports/chat.port';

export class AiChatService {
  constructor(private readonly portFactory: ChatPortFactory) {}

  async complete(model: string, apiKey: string, messages: ChatMessage[]): Promise<string> {
    const port = this.portFactory.create(model, apiKey);
    return port.complete(messages);
  }

  stream(model: string, apiKey: string, messages: ChatMessage[]): AsyncIterable<string> {
    const port = this.portFactory.create(model, apiKey);
    return port.stream(messages);
  }
}
