import { tipc, getRendererHandlers } from '@egoist/tipc/main';
import type { ChatMessage } from '../../types/chat-message.model';
import type { AiChatService } from '../services/ai-chat.service';
import type { AiChatRendererHandlers } from './ai-chat.handlers';
import type { ReasoningEffort } from '../ports/chat.port';
import { getOpenaiApiKey } from '../get-openai-api-key';

export interface AiChatInput {
  id: string;
  model: string;
  prompt: string;
  stream: boolean;
  webSearch?: boolean;
  reasoning?: boolean;
  reasoningEffort?: ReasoningEffort;
}

export interface AiChatOutput {
  text?: string;
  reasoning?: string;
  error?: string;
}

const t = tipc.create();

const MARKDOWN_SYSTEM_PROMPT = 'Always respond using Markdown formatting (headings, lists, code fences with language tags, tables, bold/italic) where appropriate.';

export function createAiChatRouter(service: AiChatService) {
  return t.router({
    chat: t.procedure.input<AiChatInput>().action(async ({ input, context }): Promise<AiChatOutput> => {
      const messages: ChatMessage[] = [
        { role: 'system', content: MARKDOWN_SYSTEM_PROMPT },
        { role: 'user', content: input.prompt },
      ];
      const options = { webSearch: input.webSearch, reasoning: input.reasoning, reasoningEffort: input.reasoningEffort };

      if (!input.stream) {
        try {
          const result = await service.complete(input.model, getOpenaiApiKey(), messages, options);
          return result;
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      }

      const handlers = getRendererHandlers<AiChatRendererHandlers>(context.sender);
      try {
        for await (const chunk of service.stream(input.model, getOpenaiApiKey(), messages, options)) {
          if (chunk.type === 'text') {
            handlers.onAiChunk.send({ id: input.id, delta: chunk.delta });
          } else {
            handlers.onAiReasoningChunk.send({ id: input.id, delta: chunk.delta });
          }
        }
        handlers.onAiDone.send({ id: input.id });
      } catch (error) {
        handlers.onAiError.send({
          id: input.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return {};
    }),
  });
}
