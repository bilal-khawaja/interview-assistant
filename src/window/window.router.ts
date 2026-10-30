import { tipc } from '@egoist/tipc/main';

export interface SetOpacityInput {
  opacity: number;
}

export interface SetClickThroughInput {
  enabled: boolean;
}

export interface ResizePillInput {
  height: number;
}

const t = tipc.create();

export function createWindowRouter(
  applyClickThrough: (enabled: boolean) => void,
  applyOpacity: (opacity: number) => void,
  resizePill: (height: number) => void,
  hidePill: () => void,
  copyText: (text: string) => void,
) {
  return t.router({
    setOpacity: t.procedure.input<SetOpacityInput>().action(async ({ input }) => {
      applyOpacity(input.opacity);
    }),
    setClickThrough: t.procedure.input<SetClickThroughInput>().action(async ({ input }) => {
      applyClickThrough(input.enabled);
    }),
    resizePill: t.procedure.input<ResizePillInput>().action(async ({ input }) => {
      resizePill(input.height);
    }),
    hidePill: t.procedure.action(async () => {
      hidePill();
    }),
    /** Puts text on the system clipboard. The renderer's own clipboard API is refused by the permission handler. */
    copyText: t.procedure.input<{ text: string }>().action(async ({ input }) => {
      copyText(input.text);
    }),
  });
}
