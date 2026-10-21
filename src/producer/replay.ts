import { z } from "zod";
import type { SourceSegment, TranscriptSource } from "./source";

const fixtureSchema = z
  .array(
    z.object({
      text: z.string().min(1),
      startMs: z.number().int().nonnegative(),
      endMs: z.number().int().nonnegative(),
      speakerKey: z.string().nullable().optional(),
    }),
  )
  .min(1);

export type FixtureSegment = z.infer<typeof fixtureSchema>[number];

export async function loadFixture(path: string): Promise<FixtureSegment[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`fixture not found: ${path}`);
  return fixtureSchema.parse(await file.json());
}

export type ReplayOptions = {
  file: string;
  count?: number;
  intervalMs: number;
  startOffsetMs?: number;
};

export class ReplaySource implements TranscriptSource {
  constructor(private readonly options: ReplayOptions) {}

  async *stream(signal: AbortSignal): AsyncGenerator<SourceSegment> {
    const fixture = await loadFixture(this.options.file);
    const segments = fixture.slice(0, this.options.count ?? fixture.length);
    const offset = this.options.startOffsetMs ?? 0;

    for (const [index, segment] of segments.entries()) {
      if (signal.aborted) return;
      yield {
        text: segment.text,
        startMs: segment.startMs + offset,
        endMs: segment.endMs + offset,
        speakerKey: segment.speakerKey ?? null,
        source: "replay",
      };
      if (index < segments.length - 1) await sleep(this.options.intervalMs, signal);
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
