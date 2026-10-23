import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { env } from "../src/env";
import { YoutubeDeepgramSource, parseVideoId } from "../src/producer/youtube";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    out: { type: "string" },
    "max-seconds": { type: "string" },
    realtime: { type: "boolean", default: false },
  },
});

const [url] = positionals;
if (!url) {
  console.error("usage: bun run scripts/record-fixture.ts <youtube-url> [--max-seconds N] [--out file] [--realtime]");
  process.exit(2);
}
if (!env.DEEPGRAM_API_KEY) {
  console.error("DEEPGRAM_API_KEY is not set");
  process.exit(1);
}

const out = values.out ?? `fixtures/${parseVideoId(url)}.json`;
const source = new YoutubeDeepgramSource({
  url,
  deepgram: { apiKey: env.DEEPGRAM_API_KEY },
  baseMs: 0,
  maxSeconds: values["max-seconds"] ? Number(values["max-seconds"]) : undefined,
  realtime: values.realtime,
});

const abort = new AbortController();
process.on("SIGINT", () => abort.abort());

const segments: { text: string; startMs: number; endMs: number; speakerKey: string | null }[] = [];
try {
  for await (const segment of source.stream(abort.signal)) {
    segments.push({
      text: segment.text,
      startMs: segment.startMs,
      endMs: segment.endMs,
      speakerKey: segment.speakerKey ?? null,
    });
    console.log(`REC ${segments.length} ${segment.startMs}ms ${segment.speakerKey ?? "-"} ${JSON.stringify(segment.text)}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
}

if (segments.length === 0) {
  console.error("nothing recorded");
  process.exit(1);
}

await mkdir(dirname(out), { recursive: true });
await Bun.write(out, `${JSON.stringify(segments, null, 2)}\n`);
const speakers = new Set(segments.map((s) => s.speakerKey));
console.log(`RECORDED ${segments.length} segments, ${speakers.size} speaker keys, ${segments.at(-1)!.endMs}ms -> ${out}`);
