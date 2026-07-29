import { tipc } from '@egoist/tipc/main';
import type { RealtimeToken } from '@tanstack/ai';
import type { AiRealtimeService } from '../services/ai-realtime.service';
import { getOpenaiApiKey } from '../get-openai-api-key';

export interface RealtimeTokenInput {
  model: string;
}

const t = tipc.create();

export function createAiRealtimeRouter(service: AiRealtimeService) {
  return t.router({
    realtimeToken: t.procedure
      .input<RealtimeTokenInput>()
      .action(({ input }): Promise<RealtimeToken> => service.mintToken(getOpenaiApiKey(), input.model)),
  });
}
