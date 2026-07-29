import type { RealtimeToken } from '@tanstack/ai';

export interface RealtimeTokenPort {
  mintToken(): Promise<RealtimeToken>;
}

export interface RealtimeTokenPortFactory {
  create(apiKey: string, model: string): RealtimeTokenPort;
}
