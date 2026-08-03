import { chat } from '@tanstack/ai';
import { createOpenaiChat } from '@tanstack/ai-openai';
import { webSearchPreviewTool } from '@tanstack/ai-openai/tools';
import type { ChatMessage } from '../../types/chat-message.model';
import type { ChatCompleteResult, ChatOptions, ChatPort, ChatPortFactory, ChatStreamChunk } from '../ports/chat.port';

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

  async complete(messages: ChatMessage[], options?: ChatOptions): Promise<ChatCompleteResult> {
    const { systemPrompts, messages: rest } = splitSystemPrompts(messages);
    const tools = options?.webSearch ? [webSearchPreviewTool({ type: 'web_search_preview' })] : undefined;
    const modelOptions = options?.reasoning
      ? { reasoning: { effort: options.reasoningEffort ?? 'medium', summary: 'auto' as const } }
      : undefined;
    const text = await chat({ adapter: this.adapter, messages: rest, systemPrompts, tools, modelOptions, stream: false });
    return { text };
  }

  async *stream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<ChatStreamChunk> {
    const { systemPrompts, messages: rest } = splitSystemPrompts(messages);
    const tools = options?.webSearch ? [webSearchPreviewTool({ type: 'web_search_preview' })] : undefined;
    const modelOptions = options?.reasoning
      ? { reasoning: { effort: options.reasoningEffort ?? 'medium', summary: 'auto' as const } }
      : undefined;
    const stream = chat({ adapter: this.adapter, messages: rest, systemPrompts, tools, modelOptions, stream: true });
    let sawText = false;
    const seenTypes = new Set<string>();
    for await (const chunk of stream) {
      seenTypes.add(chunk.type);
      if (chunk.type === 'TEXT_MESSAGE_CONTENT' && chunk.delta) {
        sawText = true;
        yield { type: 'text', delta: chunk.delta };
      } else if (chunk.type === 'REASONING_MESSAGE_CONTENT' && chunk.delta) {
        yield { type: 'reasoning', delta: chunk.delta };
      } else if (chunk.type === 'RUN_ERROR') {
        throw new Error(chunk.message ?? 'Chat run failed');
      }
    }
    if (!sawText) {
      throw new Error(`Model produced no text. Events seen: ${[...seenTypes].join(', ') || 'none'}`);
    }
  }
}

export class OpenaiChatAdapterFactory implements ChatPortFactory {
  create(model: string, apiKey: string): ChatPort {
    return new OpenaiChatAdapter(model, apiKey);
  }
}
