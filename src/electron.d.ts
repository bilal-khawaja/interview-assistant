// Type definitions for the generic tipc bridge exposed via preload script.
// Per-feature request/response and event types come from `@egoist/tipc`
// (`createClient<AppRouter>` / `createEventHandlers<AiChatRendererHandlers>`),
// not from this file.
import type { IpcRendererEvent } from 'electron';

export interface TipcBridge {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    send: (channel: string, ...args: unknown[]) => void;
    on: (
        channel: string,
        handler: (event: IpcRendererEvent, ...args: unknown[]) => void,
    ) => () => void;
}

declare global {
    interface Window {
        ipc: TipcBridge;
    }
}
