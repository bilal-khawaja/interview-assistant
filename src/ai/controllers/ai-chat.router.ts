import { tipc, getRendererHandlers } from '@egoist/tipc/main';
import type { ChatMessage } from '../../types/chat-message.model';
import type { AiChatService } from '../services/ai-chat.service';
import type { AiChatRendererHandlers } from './ai-chat.handlers';
import { getOpenaiApiKey } from '../get-openai-api-key';

export interface AiChatInput {
  id: string;
  model: string;
  prompt: string;
  stream: boolean;
}

export interface AiChatOutput {
  text?: string;
  error?: string;
}

const t = tipc.create();

export function createAiChatRouter(service: AiChatService) {
  return t.router({
    chat: t.procedure.input<AiChatInput>().action(async ({ input, context }): Promise<AiChatOutput> => {
      const messages: ChatMessage[] = [{ role: 'user', content: input.prompt }];

      if (!input.stream) {
        try {
          const text = await service.complete(input.model, getOpenaiApiKey(), messages);
          return { text };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      }

      const handlers = getRendererHandlers<AiChatRendererHandlers>(context.sender);
      try {
        for await (const delta of service.stream(input.model, getOpenaiApiKey(), messages)) {
          handlers.onAiChunk.send({ id: input.id, delta });
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
