// Preload script for secure IPC communication
// See: https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electron', {
    aiChat: (req: {
        id: string;
        apiKey: string;
        model: string;
        prompt: string;
        stream: boolean;
    }) => ipcRenderer.invoke('ai:chat', req),
    onAiChunk: (callback: (data: { id: string; delta: string }) => void) => {
        const listener = (_event: unknown, data: { id: string; delta: string }) => callback(data);
        ipcRenderer.on('ai:chunk', listener);
        return () => ipcRenderer.removeListener('ai:chunk', listener);
    },
    onAiDone: (callback: (data: { id: string }) => void) => {
        const listener = (_event: unknown, data: { id: string }) => callback(data);
        ipcRenderer.on('ai:done', listener);
        return () => ipcRenderer.removeListener('ai:done', listener);
    },
    onAiError: (callback: (data: { id: string; message: string }) => void) => {
        const listener = (_event: unknown, data: { id: string; message: string }) => callback(data);
        ipcRenderer.on('ai:error', listener);
        return () => ipcRenderer.removeListener('ai:error', listener);
    },
});
