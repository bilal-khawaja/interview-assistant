// Type definitions for Electron API exposed via preload script

export interface AiChatRequest {
    id: string;
    apiKey: string;
    model: string;
    prompt: string;
    stream: boolean;
}

export interface AiChatResult {
    text?: string;
    error?: string;
}

export interface ElectronAPI {
    aiChat: (req: AiChatRequest) => Promise<AiChatResult | null>;
    onAiChunk: (callback: (data: { id: string; delta: string }) => void) => () => void;
    onAiDone: (callback: (data: { id: string }) => void) => () => void;
    onAiError: (callback: (data: { id: string; message: string }) => void) => () => void;
}

declare global {
    interface Window {
        electron: ElectronAPI;
    }
}
