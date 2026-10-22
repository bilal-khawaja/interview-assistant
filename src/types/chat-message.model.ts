export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Epoch ms when the message was created; absent on messages saved before this field existed. */
  sentAt?: number;
}

export interface ChatRequest {
  model: string;
  apiKey: string;
  messages: ChatMessage[];
}
