import type { WSContext } from "hono/ws";
import type { StreamSink } from "./transcript-stream";

export function sinkFor(ws: WSContext): StreamSink {
  const raw = ws.raw as { getBufferedAmount?: () => number } | undefined;
  return {
    send(frame) {
      if (ws.readyState === 1) ws.send(JSON.stringify(frame));
    },
    bufferedAmount: () => raw?.getBufferedAmount?.() ?? 0,
    close: (code, reason) => ws.close(code, reason),
  };
}
