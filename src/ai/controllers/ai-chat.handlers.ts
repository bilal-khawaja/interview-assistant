/**
 * Main -> renderer push events for streamed chat output.
 * Shared type between the main-process sender and the renderer listener.
 */
export type AiChatRendererHandlers = {
  onAiChunk: (data: { id: string; delta: string }) => void;
  onAiDone: (data: { id: string }) => void;
  onAiError: (data: { id: string; message: string }) => void;
};
