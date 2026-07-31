import { tipc } from '@egoist/tipc/main';
import { autoUpdater, type BrowserWindow } from 'electron';

const t = tipc.create();

export function createUpdateRouter(getUpdateWindow: () => BrowserWindow | null) {
  return t.router({
    installUpdate: t.procedure.action(async () => {
      autoUpdater.quitAndInstall();
    }),
    closeUpdateWindow: t.procedure.action(async () => {
      getUpdateWindow()?.close();
    }),
  });
}
