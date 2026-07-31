import { tipc } from '@egoist/tipc/main';
import type { BrowserWindow } from 'electron';
import { markVersionSeen, wipeUserData, relaunchSkippingUpgradeCheck } from './first.run';

const t = tipc.create();

export function createUpgradeRouter(getUpgradeWindow: () => BrowserWindow | null) {
  return t.router({
    resetAndRelaunch: t.procedure.action(async () => {
      wipeUserData();
      relaunchSkippingUpgradeCheck();
    }),
    keepAndContinue: t.procedure.action(async () => {
      markVersionSeen();
      getUpgradeWindow()?.close();
    }),
  });
}
