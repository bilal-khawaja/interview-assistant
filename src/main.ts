import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { chat } from '@tanstack/ai';
import { createOpenaiChat } from '@tanstack/ai-openai';

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

type AiChatRequest = {
  id: string;
  apiKey: string;
  model: string;
  prompt: string;
  stream: boolean;
};

ipcMain.handle('ai:chat', async (event, req: AiChatRequest) => {
  const adapter = createOpenaiChat(req.model as Parameters<typeof createOpenaiChat>[0], req.apiKey);
  const messages = [{ role: 'user' as const, content: req.prompt }];

  if (!req.stream) {
    try {
      const text = await chat({ adapter, messages, stream: false });
      return { text };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  const sender = event.sender;
  try {
    const stream = chat({ adapter, messages, stream: true });
    for await (const chunk of stream) {
      if (chunk.type === 'TEXT_MESSAGE_CONTENT' && chunk.delta) {
        sender.send('ai:chunk', { id: req.id, delta: chunk.delta });
      }
    }
    sender.send('ai:done', { id: req.id });
  } catch (error) {
    sender.send('ai:error', {
      id: req.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return null;
});

app.whenReady().then(createWindow);

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
