import type { TranscriptSegment } from "../db/schema";
import type { WakeHub } from "./wake";

/** Anything read from a gapless, ordered log. */
export type Sequenced = { seq: number };

export type ReadAfter<T extends Sequenced = TranscriptSegment> = (
  key: string,
  afterSeq: number,
  limit: number,
) => Promise<T[]>;

export type ConsumeDeps<T extends Sequenced = TranscriptSegment> = {
  hub: WakeHub;
  readAfter: ReadAfter<T>;
  batchSize?: number;
  pollMs?: number;
};

/** `key` is the meeting id for the transcript log and the chat id for a chat's messages. */
export async function* consume<T extends Sequenced = TranscriptSegment>(
  deps: ConsumeDeps<T>,
  key: string,
  from: number,
  signal: AbortSignal,
): AsyncGenerator<T[], void, void> {
  const batchSize = deps.batchSize ?? 200;
  const pollMs = deps.pollMs ?? 5_000;
  const sub = deps.hub.subscribe(key);
  try {
    let cursor = from;
    while (!signal.aborted) {
      sub.clear();
      const rows = await deps.readAfter(key, cursor, batchSize);
      const last = rows.at(-1);
      if (last) {
        cursor = last.seq;
        yield rows;
        continue;
      }
      if (sub.pending) continue;
      await sub.sleep(signal, pollMs);
    }
  } finally {
    sub.close();
  }
}
