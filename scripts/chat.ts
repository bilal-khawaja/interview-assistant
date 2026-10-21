import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { env } from "../src/env";

const USAGE = `usage: bun run chat <meetingId> [options]

Talks to a chat on a running server (bun run server).

options:
  --chat <id>     resume this chat (default: create a new one)
  --title <name>  title for a new chat
  --host <h:p>    server address (default: localhost:${env.PORT})
  --all           also show background suggestion and summary messages

At the prompt, type a message to queue a follow-up, or "/steer <message>" to interrupt the
current answer. Ctrl+C quits; resume later with --chat <id>.`;

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    chat: { type: "string" },
    title: { type: "string", default: "cli" },
    host: { type: "string", default: `localhost:${env.PORT}` },
    all: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

const [meetingId] = positionals;
if (values.help || !meetingId) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 2);
}

const http = `http://${values.host}`;
const base = `/meetings/${meetingId}`;

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${http}${path}`, { headers: { "content-type": "application/json" }, ...init });
}

let chatId = values.chat;
if (!chatId) {
  const created = await api(`${base}/chats`, { method: "POST", body: JSON.stringify({ title: values.title }) });
  if (!created.ok) {
    console.error(`could not create chat: ${created.status} ${await created.text()}`);
    process.exit(1);
  }
  chatId = ((await created.json()) as { id: string }).id;
}
console.log(`CHAT ${chatId}  (resume with: bun run chat ${meetingId} --chat ${chatId})`);

let lastSeq = 0;
let attempt = 0;
let stopping = false;

const lines = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });

/** Prints above the input line, then redraws the prompt so typing is never overwritten. */
function log(text: string) {
  process.stdout.write("\r\u001b[K");
  console.log(text);
  lines.prompt(true);
}

function print(frame: { seq: number; role: string; kind: string; content: string }) {
  const who = frame.role === "user" ? "you" : frame.role === "assistant" ? frame.kind : frame.role;
  if (!values.all && who !== "you" && who !== "reply") return;
  log(`[${frame.seq}] ${who}: ${frame.content}`);
}

function connect() {
  const ws = new WebSocket(`ws://${values.host}${base}/chats/${chatId}/stream?after=${lastSeq}`);
  ws.onopen = () => {
    attempt = 0;
  };
  ws.onmessage = (event) => {
    const frame = JSON.parse(String(event.data));
    if (frame.type === "message") {
      // The stream replays from lastSeq, so a reconnect cannot show a message twice.
      if (frame.seq <= lastSeq) return;
      if (frame.seq !== lastSeq + 1) log(`GAP expected=${lastSeq + 1} got=${frame.seq}`);
      lastSeq = frame.seq;
      print(frame);
    } else if (frame.type === "degraded") {
      log(`(server cannot reach its database: ${frame.reason})`);
    } else if (frame.type === "recovered") {
      log("(server recovered)");
    } else if (frame.type === "error") {
      log(`ERROR ${frame.code}: ${frame.message}`);
    }
  };
  ws.onclose = (event) => {
    if (stopping) return;
    if (event.code === 4409) {
      log("this chat has fewer messages than the position we resumed from");
      process.exit(1);
    }
    const delay = Math.min(5_000, 200 * 2 ** attempt++);
    log(`(disconnected; reconnecting in ${delay}ms)`);
    setTimeout(connect, delay);
  };
  ws.onerror = () => undefined;
}
connect();

/** Re-sends with the same messageId until the server answers, so a lost response cannot duplicate the message. */
async function send(mode: "steer" | "followup", text: string): Promise<void> {
  const messageId = crypto.randomUUID();
  for (let tries = 0; tries < 5 && !stopping; tries++) {
    try {
      const response = await api(`${base}/chats/${chatId}/messages`, {
        method: "POST",
        body: JSON.stringify({ messageId, mode, text }),
      });
      if (response.ok) return;
      log(`rejected: ${response.status} ${await response.text()}`);
      if (response.status < 500) return;
    } catch {
      // network error: retry with the same id
    }
    await Bun.sleep(Math.min(5_000, 300 * 2 ** tries));
  }
  log("could not send the message");
}

lines.prompt();
lines.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  const steer = text.startsWith("/steer ");
  void send(steer ? "steer" : "followup", steer ? text.slice(7).trim() : text);
});
lines.on("close", () => process.exit(0));
process.on("SIGINT", () => {
  stopping = true;
  process.exit(0);
});
