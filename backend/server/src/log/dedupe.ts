import type { DeliveryHandler } from "./consumer";

export function dedupeHandler(
  handler: DeliveryHandler,
  initialWatermark = 0,
): DeliveryHandler {
  let watermark = initialWatermark;
  return async (delivery) => {
    const fresh = delivery.segments.filter((s) => s.seq > watermark);
    const last = fresh.at(-1);
    if (!last) return;
    await handler({ ...delivery, segments: fresh });
    watermark = last.seq;
  };
}
