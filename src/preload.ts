// Preload script for secure IPC communication
// See: https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

// Generic tipc bridge: type safety comes from `@egoist/tipc`'s createClient /
// createEventHandlers on the renderer side, not from bespoke per-feature methods here.
contextBridge.exposeInMainWorld('ipc', {
    invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
    send: (channel: string, ...args: unknown[]) => ipcRenderer.send(channel, ...args),
    on: (channel: string, handler: (event: IpcRendererEvent, ...args: unknown[]) => void) => {
        ipcRenderer.on(channel, handler);
        return () => ipcRenderer.removeListener(channel, handler);
    },
});
