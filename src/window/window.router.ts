import { tipc } from '@egoist/tipc/main';
import type { BrowserWindow } from 'electron';

export interface SetOpacityInput {
  opacity: number;
}

export interface SetClickThroughInput {
  enabled: boolean;
}

const t = tipc.create();

export function createWindowRouter(getWindow: () => BrowserWindow | null) {
  return t.router({
    setOpacity: t.procedure.input<SetOpacityInput>().action(async ({ input }) => {
      getWindow()?.setOpacity(input.opacity);
    }),
    setClickThrough: t.procedure.input<SetClickThroughInput>().action(async ({ input }) => {
      getWindow()?.setIgnoreMouseEvents(input.enabled, { forward: true });
    }),
  });
}
