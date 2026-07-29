import 'dotenv/config';
import { app, BrowserWindow, session } from 'electron';
import path from 'node:path';
import dns from 'node:dns';

// Node's resolver tries IPv6 first by default and can hard-fail
// (ENOTFOUND) on networks where IPv6 is broken, even though Chromium's
// own resolver (used by the renderer) works fine. Main-process fetch calls
// (e.g. minting the realtime token) go through Node's resolver, so this
// must be set here.
dns.setDefaultResultOrder('ipv4first');
import started from 'electron-squirrel-startup';
import { registerIpcMain } from '@egoist/tipc/main';
import { AiChatService } from './ai/services/ai-chat.service';
import { createAiChatRouter } from './ai/controllers/ai-chat.router';
import { OpenaiChatAdapterFactory } from './ai/adapters/openai.adapter';
import { AiRealtimeService } from './ai/services/ai-realtime.service';
import { createAiRealtimeRouter } from './ai/controllers/ai-realtime.router';
import { OpenaiRealtimeTokenAdapterFactory } from './ai/adapters/openai-realtime-token.adapter';

// Handle Squirrel events on Windows (install/update/uninstall)
if (started) {
  app.quit();
}

const createWindow = () => {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
};

const aiChatService = new AiChatService(new OpenaiChatAdapterFactory());
const aiRealtimeService = new AiRealtimeService(new OpenaiRealtimeTokenAdapterFactory());

const router = {
  ai: {
    ...createAiChatRouter(aiChatService),
    ...createAiRealtimeRouter(aiRealtimeService),
  },
};
registerIpcMain(router);

export type AppRouter = typeof router;

app.whenReady().then(() => {
  // Realtime voice chat needs the mic (getUserMedia) — Electron denies media
  // permission requests by default unless explicitly allowed here.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
