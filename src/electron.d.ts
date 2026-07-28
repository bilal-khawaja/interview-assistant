// Type definitions for Electron API exposed via preload script

export interface ElectronAPI {
    // Add your IPC API methods here
    // Example: ping: () => Promise<string>;
}

declare global {
    interface Window {
        electron: ElectronAPI;
    }
}
