import { realtimeToken, type RealtimeToken } from '@tanstack/ai';
import { openaiRealtimeToken, type OpenAIRealtimeModel } from '@tanstack/ai-openai';
import type { RealtimeTokenPort, RealtimeTokenPortFactory } from '../ports/realtime-token.port';

export class OpenaiRealtimeTokenAdapter implements RealtimeTokenPort {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async mintToken(): Promise<RealtimeToken> {
    if (!this.apiKey) {
      throw new Error('OpenAI API key is required to mint a realtime token.');
    }

    // openaiRealtimeToken() only reads OPENAI_API_KEY from process.env — no
    // per-call override. Bridge the runtime-entered key through the env var
    // for the duration of this single mint call, then restore it. A previously
    // *unset* var must be deleted on restore, not reassigned `undefined` —
    // Node's env proxy stringifies that to the literal `"undefined"`.
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = this.apiKey;
    try {
      return await realtimeToken({
        adapter: openaiRealtimeToken({ model: this.model as OpenAIRealtimeModel }),
      });
    } finally {
      if (previous === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previous;
      }
    }
  }
}

export class OpenaiRealtimeTokenAdapterFactory implements RealtimeTokenPortFactory {
  create(apiKey: string, model: string): RealtimeTokenPort {
    return new OpenaiRealtimeTokenAdapter(apiKey, model);
  }
}
