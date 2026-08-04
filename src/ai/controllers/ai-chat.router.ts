import { tipc, getRendererHandlers } from '@egoist/tipc/main';
import type { ChatMessage } from '../../types/chat-message.model';
import type { AiChatService } from '../services/ai-chat.service';
import type { AiChatRendererHandlers } from './ai-chat.handlers';
import type { ReasoningEffort } from '../ports/chat.port';
import { getOpenaiApiKey } from '../get-openai-api-key';
import { extractAttachmentsText, type FileAttachment } from '../services/file-extract.service';

export interface AiChatInput {
  id: string;
  model: string;
  prompt: string;
  stream: boolean;
  webSearch?: boolean;
  reasoning?: boolean;
  reasoningEffort?: ReasoningEffort;
  attachments?: FileAttachment[];
}

export interface AiChatOutput {
  text?: string;
  reasoning?: string;
  error?: string;
}

export interface AiTitleChatInput {
  prompt: string;
}

export interface AiTitleChatOutput {
  title?: string;
  error?: string;
}

const t = tipc.create();

const MARKDOWN_SYSTEM_PROMPT = 'Always respond using Markdown formatting (headings, lists, code fences with language tags, tables, bold/italic) where appropriate.';
const TITLE_MODEL = 'gpt-4.1-nano';
const TITLE_SYSTEM_PROMPT = 'Generate a short chat title (3-5 words, no quotes, no punctuation at the end) that summarizes the user message. Reply with only the title text.';

export function createAiChatRouter(service: AiChatService) {
  return t.router({
    chat: t.procedure.input<AiChatInput>().action(async ({ input, context }): Promise<AiChatOutput> => {
      let userContent = input.prompt;
      if (input.attachments?.length) {
        const extracted = await extractAttachmentsText(input.attachments);
        userContent = `${input.prompt}\n\nAttached files:\n${extracted}`;
      }
      const messages: ChatMessage[] = [
        { role: 'system', content: MARKDOWN_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
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

    titleChat: t.procedure.input<AiTitleChatInput>().action(async ({ input }): Promise<AiTitleChatOutput> => {
      const messages: ChatMessage[] = [
        { role: 'system', content: TITLE_SYSTEM_PROMPT },
        { role: 'user', content: input.prompt },
      ];
      try {
        const result = await service.complete(TITLE_MODEL, getOpenaiApiKey(), messages);
        return { title: result.text.trim() };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }),
  });
}
