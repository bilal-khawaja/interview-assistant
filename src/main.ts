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
import { createUpdateWindow, createPillWindow, positionPillTopCenter, PILL_WIDTH } from './window/window.settings';

app.setName('System Container');

// Handle Squirrel events on Windows (install/update/uninstall)
if (started) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let updateWindow: BrowserWindow | null = null;
let upgradeWindow: BrowserWindow | null = null;
let pillWindow: BrowserWindow | null = null;

const createWindow = () => {
  mainWindow = new BrowserWindow({
    title: 'System Container',
    frame: false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
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

// Single source of truth for click-through state, shared between the
// settings toggle (renderer -> tipc) and the Ctrl+Shift+X shortcut, so
// neither can drift out of sync with the other.
let clickThroughEnabled = false;
const applyClickThrough = (enabled: boolean) => {
  if (!mainWindow) return;
  clickThroughEnabled = enabled;
  mainWindow.setIgnoreMouseEvents(enabled, { forward: true });
  mainWindow.setAlwaysOnTop(enabled, 'screen-saver', 1);
  if (enabled) mainWindow.moveTop();
};

// Single source of truth for opacity, shared between the settings slider
// (renderer -> tipc) and the Ctrl+I/Ctrl+D shortcuts.
const OPACITY_STEP = 0.05;
const OPACITY_MIN = 0.2;
const OPACITY_MAX = 1;
let windowOpacity = 1;
const applyOpacity = (opacity: number) => {
  if (!mainWindow) return;
  windowOpacity = Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, opacity));
  mainWindow.setOpacity(windowOpacity);
};

// Tracks whether the main window was actually visible right before the pill
// hid it, so hiding the pill only restores it when that was the case (e.g.
// not when the user had already stealth-hidden it via Ctrl+\).
let mainWasVisibleBeforePill = false;

const showPill = () => {
  if (mainWindow?.isVisible()) {
    mainWasVisibleBeforePill = true;
    mainWindow.hide();
  }
  if (!pillWindow || pillWindow.isDestroyed()) {
    pillWindow = createPillWindow();
  }
  positionPillTopCenter(pillWindow);
  pillWindow.show();
};

const hidePill = () => {
  pillWindow?.hide();
  if (mainWasVisibleBeforePill) {
    mainWasVisibleBeforePill = false;
    mainWindow?.show();
  }
};

const togglePill = () => {
  if (pillWindow && !pillWindow.isDestroyed() && pillWindow.isVisible()) {
    hidePill();
  } else {
    showPill();
  }
};

const resizePill = (height: number) => {
  if (!pillWindow || pillWindow.isDestroyed()) return;
  pillWindow.setSize(PILL_WIDTH, Math.round(height));
};

const router = {
  ai: {
    ...createAiChatRouter(aiChatService),
    ...createAiRealtimeRouter(aiRealtimeService),
  },
  window: createWindowRouter(applyClickThrough, applyOpacity, resizePill, hidePill),
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

  // <webview> guest pages run in their own webContents/process, so keydown
  // inside them never reaches the host renderer's window listener. Catch the
  // find-in-page shortcut here and forward it to the host window, tagged with
  // the guest's webContents id so only the matching pane's find bar opens.
  app.on('web-contents-created', (_event, contents) => {
    console.log('[find-debug] web-contents-created type=', contents.getType());
    if (contents.getType() !== 'webview') return;
    contents.on('before-input-event', (_inputEvent, input) => {
      console.log('[find-debug] before-input-event', input.type, input.key, input.control, input.meta);
      if (input.type !== 'keyDown') return;
      if (!(input.control || input.meta) || input.key.toLowerCase() !== 'f') return;
      if (!mainWindow) return;
      getRendererHandlers<WindowRendererHandlers>(mainWindow.webContents).onBrowserFindShortcut.send({
        webContentsId: contents.id,
      });
    });
  });

  // Click-through can make the whole window unclickable, so this shortcut is
  // the only way back in — it flips click-through on/off and tells the
  // renderer to sync its toggle to match.
  const toggleClickThrough = () => {
    if (!mainWindow) return;
    applyClickThrough(!clickThroughEnabled);
    getRendererHandlers<WindowRendererHandlers>(mainWindow.webContents).onClickThroughChanged.send({
      enabled: clickThroughEnabled,
    });
  };

  if (!globalShortcut.register('CommandOrControl+Shift+X', toggleClickThrough)) {
    console.error('Failed to register CommandOrControl+Shift+X shortcut.');
  }

  const nudgeOpacity = (delta: number) => {
    if (!mainWindow) return;
    applyOpacity(windowOpacity + delta);
    getRendererHandlers<WindowRendererHandlers>(mainWindow.webContents).onOpacityChanged.send({
      opacity: windowOpacity,
    });
  };

  if (!globalShortcut.register('CommandOrControl+I', () => nudgeOpacity(OPACITY_STEP))) {
    console.error('Failed to register CommandOrControl+I shortcut.');
  }

  if (!globalShortcut.register('CommandOrControl+D', () => nudgeOpacity(-OPACITY_STEP))) {
    console.error('Failed to register CommandOrControl+D shortcut.');
  }

  // Floating pill toolbar — not shown at launch, only summoned on demand.
  if (!globalShortcut.register('CommandOrControl+T', togglePill)) {
    console.error('Failed to register CommandOrControl+T shortcut.');
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
