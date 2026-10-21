import { parseArgs } from "node:util";
import { env } from "../src/env";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    after: { type: "string", default: "0" },
    host: { type: "string", default: `localhost:${env.PORT}` },
    "exit-after": { type: "string" },
  },
});

const [meetingId] = positionals;
if (!meetingId) {
  console.error("usage: bun run scripts/stream-client.ts <meetingId> [--after N] [--host host:port] [--exit-after N]");
  process.exit(2);
}

let lastSeq = Number(values.after);
const exitAfter = values["exit-after"] ? Number(values["exit-after"]) : undefined;
let received = 0;
let attempt = 0;
let stopping = false;

function stop(code = 0) {
  stopping = true;
  console.log(`CLIENT done received=${received} last_seq=${lastSeq}`);
  process.exit(code);
}
process.on("SIGINT", () => stop());

function connect() {
  const url = `ws://${values.host}/meetings/${meetingId}/stream?after=${lastSeq}`;
  console.log(`CLIENT connecting after=${lastSeq}`);
  const ws = new WebSocket(url);

  ws.onopen = () => {
    attempt = 0;
  };

  ws.onmessage = (event) => {
    const frame = JSON.parse(String(event.data));
    if (frame.type === "ready") {
      console.log(`READY head=${frame.head} after=${frame.after}`);
    } else if (frame.type === "segment") {
      if (frame.seq <= lastSeq) {
        console.log(`DUPLICATE seq=${frame.seq}`);
        return;
      }
      if (frame.seq !== lastSeq + 1) console.log(`GAP expected=${lastSeq + 1} got=${frame.seq}`);
      lastSeq = frame.seq;
      received++;
      const who = frame.speaker?.person.fullName ?? frame.speakerKey ?? "-";
      console.log(`SEG seq=${frame.seq} speaker=${who} text=${JSON.stringify(frame.text)}`);
      if (exitAfter !== undefined && received >= exitAfter) stop();
    } else if (frame.type === "degraded") {
      console.log(`DEGRADED ${frame.reason}`);
    } else if (frame.type === "recovered") {
      console.log("RECOVERED");
    } else if (frame.type === "error") {
      console.log(`ERROR code=${frame.code} message=${frame.message}`);
    }
  };

  ws.onclose = (event) => {
    if (stopping) return;
    if (event.code === 4409) {
      console.log("CLIENT cursor ahead of head; giving up");
      stop(1);
    }
    const delay = Math.min(5_000, 200 * 2 ** attempt++);
    console.log(`CLIENT disconnected code=${event.code}; reconnecting in ${delay}ms`);
    setTimeout(connect, delay);
  };

  ws.onerror = () => undefined;
}

connect();
