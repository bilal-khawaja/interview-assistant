import { chat } from '@tanstack/ai';
import { createOpenaiChat } from '@tanstack/ai-openai';
import type { ChatMessage } from '../../types/chat-message.model';
import type { ChatPort, ChatPortFactory } from '../ports/chat.port';

type OpenaiModel = Parameters<typeof createOpenaiChat>[0];

function splitSystemPrompts(messages: ChatMessage[]) {
  const systemPrompts = messages.filter((m) => m.role === 'system').map((m) => m.content);
  const rest = messages
    .filter((m): m is ChatMessage & { role: 'user' | 'assistant' } => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));
  return { systemPrompts, messages: rest };
}

export class OpenaiChatAdapter implements ChatPort {
  private readonly adapter: ReturnType<typeof createOpenaiChat>;

  constructor(model: string, apiKey: string) {
    this.adapter = createOpenaiChat(model as OpenaiModel, apiKey);
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    const { systemPrompts, messages: rest } = splitSystemPrompts(messages);
    return chat({ adapter: this.adapter, messages: rest, systemPrompts, stream: false });
  }

  async *stream(messages: ChatMessage[]): AsyncIterable<string> {
    const { systemPrompts, messages: rest } = splitSystemPrompts(messages);
    const stream = chat({ adapter: this.adapter, messages: rest, systemPrompts, stream: true });
    for await (const chunk of stream) {
      if (chunk.type === 'TEXT_MESSAGE_CONTENT' && chunk.delta) {
        yield chunk.delta;
      }
    }
  }
}

export class OpenaiChatAdapterFactory implements ChatPortFactory {
  create(model: string, apiKey: string): ChatPort {
    return new OpenaiChatAdapter(model, apiKey);
  }
}
