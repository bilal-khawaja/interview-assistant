import { tipc } from '@egoist/tipc/main';

export interface SetOpacityInput {
  opacity: number;
}

export interface SetClickThroughInput {
  enabled: boolean;
}

const t = tipc.create();

export function createWindowRouter(
  applyClickThrough: (enabled: boolean) => void,
  applyOpacity: (opacity: number) => void,
) {
  return t.router({
    setOpacity: t.procedure.input<SetOpacityInput>().action(async ({ input }) => {
      applyOpacity(input.opacity);
    }),
    setClickThrough: t.procedure.input<SetClickThroughInput>().action(async ({ input }) => {
      applyClickThrough(input.enabled);
    }),
  });
}
