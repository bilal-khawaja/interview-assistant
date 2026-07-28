// Preload script for secure IPC communication
// See: https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import { contextBridge } from 'electron';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electron', {
    // Add your API methods here
    // Example: ping: () => ipcRenderer.invoke('ping')
});
