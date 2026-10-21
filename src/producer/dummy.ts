import { env } from "../env";
import { YoutubeDeepgramSource } from "./youtube";


const url = Bun.argv[2] || env.YOUTUBE_URL;
const maxSeconds = Number(Bun.argv[3] ?? 300);

if (!env.DEEPGRAM_API_KEY) {
  console.error("DEEPGRAM_API_KEY is not set");
  process.exit(1);
}

const abort = new AbortController();
process.on("SIGINT", () => abort.abort());

const source = new YoutubeDeepgramSource({
  url,
  deepgram: { apiKey: env.DEEPGRAM_API_KEY },
  baseMs: 0,
  maxSeconds,
  realtime: false,
});

console.log(`fetching ${maxSeconds}s of audio from ${url}`);
let count = 0;
try {
  for await (const segment of source.stream(abort.signal)) {
    count++;
    const speaker = segment.speakerKey ?? "-";
    console.log(`[${segment.startMs}-${segment.endMs}ms] speaker=${speaker}: ${segment.text}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
console.log(`done: ${count} segments`);
