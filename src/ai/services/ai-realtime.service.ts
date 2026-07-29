import type { RealtimeToken } from '@tanstack/ai';
import type { RealtimeTokenPortFactory } from '../ports/realtime-token.port';

export class AiRealtimeService {
  constructor(private readonly portFactory: RealtimeTokenPortFactory) {}

  async mintToken(apiKey: string, model: string): Promise<RealtimeToken> {
    const port = this.portFactory.create(apiKey, model);
    return port.mintToken();
  }
}
