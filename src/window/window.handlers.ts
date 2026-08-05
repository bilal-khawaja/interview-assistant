export type WindowRendererHandlers = {
  onClickThroughChanged: (data: { enabled: boolean }) => void;
  onOpacityChanged: (data: { opacity: number }) => void;
};
