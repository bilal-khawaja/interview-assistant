import 'dotenv/config';
import { app, BrowserWindow, globalShortcut, session } from 'electron';
import path from 'node:path';
import dns from 'node:dns';

// Node's resolver tries IPv6 first by default and can hard-fail
// (ENOTFOUND) on networks where IPv6 is broken, even though Chromium's
// own resolver (used by the renderer) works fine. Main-process fetch calls
// (e.g. minting the realtime token) go through Node's resolver, so this
// must be set here.
dns.setDefaultResultOrder('ipv4first');
import started from 'electron-squirrel-startup';
import { updateElectronApp } from 'update-electron-app';
import { registerIpcMain } from '@egoist/tipc/main';
import { AiChatService } from './ai/services/ai-chat.service';
import { createAiChatRouter } from './ai/controllers/ai-chat.router';
import { OpenaiChatAdapterFactory } from './ai/adapters/openai.adapter';
import { AiRealtimeService } from './ai/services/ai-realtime.service';
import { createAiRealtimeRouter } from './ai/controllers/ai-realtime.router';
import { OpenaiRealtimeTokenAdapterFactory } from './ai/adapters/openai-realtime-token.adapter';
import { createWindowRouter } from './window/window.router';
import { getRendererHandlers } from '@egoist/tipc/main';
import type { WindowRendererHandlers } from './window/window.handlers';
import { createUpdateRouter } from './window/window.update.router';
import { createUpdateWindow } from './window/window.settings';

app.setName('System Container');

// Handle Squirrel events on Windows (install/update/uninstall)
if (started) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let updateWindow: BrowserWindow | null = null;
let upgradeWindow: BrowserWindow | null = null;

const createWindow = () => {
  mainWindow = new BrowserWindow({
    title: 'System Container',
    frame: false,
    skipTaskbar: true,
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
  window: createWindowRouter(() => mainWindow),
  update: createUpdateRouter(() => updateWindow),
  // upgrade: createUpgradeRouter(() => upgradeWindow),
};
registerIpcMain(router);

export type AppRouter = typeof router;

updateElectronApp({
  notifyUser: false,
  onNotifyUser: ({ releaseNotes }) => {
    updateWindow = createUpdateWindow(releaseNotes ?? '');
  },
});

app.whenReady().then(async () => {
  // Realtime voice chat needs the mic (getUserMedia) — Electron denies media
  // permission requests by default unless explicitly allowed here.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });

  createWindow();

  // Click-through can make the whole window unclickable, so this shortcut is
  // the only way back in — it force-disables it and tells the renderer to
  // flip its toggle back off.
  const disableClickThrough = () => {
    console.log('[click-through] shortcut fired, mainWindow:', !!mainWindow);
    if (!mainWindow) return;
    mainWindow.setIgnoreMouseEvents(false);
    getRendererHandlers<WindowRendererHandlers>(mainWindow.webContents).onClickThroughChanged.send({
      enabled: false,
    });
  };

  if (!globalShortcut.register('CommandOrControl+Shift+X', disableClickThrough)) {
    console.error('Failed to register CommandOrControl+Shift+X shortcut.');
  }

  // Stealth toggle: hide/show main window without closing the process.
  const toggleMainWindow = () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
    }
  };

  if (!globalShortcut.register('CommandOrControl+\\', toggleMainWindow)) {
    console.error('Failed to register CommandOrControl+\\ shortcut.');
  }

  // Frameless window has no native close button — this is the only way to quit.
  if (!globalShortcut.register('CommandOrControl+Q', () => app.quit())) {
    console.error('Failed to register CommandOrControl+Q shortcut.');
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
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
