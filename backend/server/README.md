# Vercel AI SDK + Drizzle + pgvector demo

Install dependencies:

```bash
bun install
```

Set the OpenAI and local Postgres connection values in `.env`:

```env
OPENAI_API_KEY=your-api-key
DATABASE_URL=postgresql://postgres:<password>@localhost:5433/vectortest
STREAM_ANSWER=true
```

Generate and apply the Drizzle migration:

```bash
bun run db:generate
bun run db:migrate
```

Run the demo:

```bash
bun run start
```

You can also point the demo at a local PDF and ask it to explain the document:

```bash
bun run start "C:\\path\\to\\file.pdf" "Explain this PDF in plain English"
```

The app extracts selectable text from the PDF page by page before chunking it.
If the PDF is scanned or image-only, you will need OCR first.

The demo uses the Vercel AI SDK's `embedMany` function to create embeddings for
an example paragraph. Mastra's `MDocument` recursive chunker splits it at paragraph and
sentence boundaries before falling back to punctuation, words, and characters.
Chunks and their embeddings are stored in Postgres with Drizzle ORM and
pgvector, then retrieved with a database-side cosine similarity query.

The typed schema is in `src/infra/database/schema.ts`, the Bun SQL/Drizzle client is in
`src/infra/database/client.ts`, and generated migrations live in `src/infra/database/migrations`.
The migration creates the `vector` extension, `document_chunks` table, and HNSW
index. pgvector's `<=>` operator returns cosine distance; the query converts it
to similarity with `1 - distance`.

Each run prints per-layer duration, total duration, provider-reported token
usage as Mastra traces and logs stored in the `mastra` Postgres schema. Set `STREAM_ANSWER=true` to stream an answer from
the retrieved context. The streaming metrics include both total answer time
and time to the first non-empty text delta.

## Commands

| Command | What it does |
| --- | --- |
| `bun run start [file.pdf] [question]` | Ingest text or a PDF, retrieve chunks, stream an answer |
| `bun run inspect [asset]` | Inspect a `.png` or `.pdf` with the multimodal agent |
| `bun run typecheck` | Type check with `bun check` (Bun 1.4.3+) |
| `bun run db:generate` / `db:migrate` / `db:check` | Drizzle migrations |

## Architecture

Ports and adapters. Business logic never imports a vendor SDK.

```text
src/
  core/        business logic, no vendor imports
    domain/      types
    ports/       interfaces: Chunker, Embedder, KnowledgeBase, AnswerWriter, ...
    services/    InspectionService
  mastra/      Mastra instance (storage, logger, observability), agents,
               ingest/retrieve workflows, logInspection tool
  infra/       adapters, one folder per vendor, named after the port they implement
    mastra/      chunker, answer-writer, inspector
    openai/      client, embedder
    database/    client, schema, knowledge-base (pgvector), migrations
    pdfjs/       pdf-reader
    console/     journal
    local/       asset-store
  bootstrap/   wires adapters to workflows and agents: rag.ts, inspection.ts
  cli/         entry points: ask-document.ts, inspect-asset.ts
  constants/   models, RAG defaults, media types
  env.ts       validated environment (t3-env)
```

Mastra owns the LLM layer: agents, the ingest and retrieve workflows, tracing,
and logs. They are stored in Postgres under the `mastra` schema, which Mastra
creates on first use. The pgvector store stays on Drizzle.

To swap a vendor, add an adapter in `src/infra` and change one line in
`src/bootstrap`.

## Transcript log

An append-only transcript log with one producer per meeting and any number of
independent consumers. Postgres is the only link between them: the producer
inserts rows, a trigger sends `NOTIFY` on commit, and each consumer re-reads
from its own cursor.

```text
src/
  db/           schema/ (one file per table), repositories/, client, locks
  log/          append (producer), wake (LISTEN/NOTIFY), consume, consumer
                (at-least-once), cursor, dedupe
  producer/     TranscriptSource implementations: youtube + deepgram, replay
scripts/
  producer.ts   bun run producer ...
  consumer.ts   bun run consumer ...
```

Set `DATABASE_URL` and `DEEPGRAM_API_KEY` in `.env`; all environment access goes
through `src/env.ts`. Then `bun run db:migrate`.

```bash
bun run producer youtube                      # transcribes YOUTUBE_URL (default: Jensen Huang interview)
bun run producer youtube <url> --max-seconds 120 --no-realtime
bun run producer replay --count 20 --interval 300   # re-emits fixtures/7ARBJQn6QkM.json, no Deepgram needed
bun run scripts/record-fixture.ts <url> --max-seconds 300   # record a new fixture
bun run consumer --name alice
```

- The producer prints `meeting=<id>`. Pass `--meeting <id>` to append to an existing
  meeting or to read it from a consumer; the consumer defaults to the latest meeting.
- A consumer's cursor is keyed by `--name`, so running the same name again resumes
  where it stopped. `--fresh` uses a one-off `name-<pid>` identity that starts from the
  beginning. `--tail <n>` starts a new consumer n segments behind the head.
- Delivery is at-least-once: the cursor is committed after the handler succeeds, and
  the consumer script deduplicates redelivered segments by sequence number.
- The YouTube source uses `youtubei.js` (iOS client) to fetch the audio and streams
  the container straight to Deepgram, so neither `yt-dlp` nor `ffmpeg` is needed.
  Live streams are not supported. Use `--max-seconds` to cap a run.
- `bun test src` runs unit tests and, when the database is reachable, integration
  tests including real producer and consumer processes.

## WebSocket stream

```bash
bun run server                                  # listens on PORT (default 3000)
bun run scripts/stream-client.ts <meetingId>    # reconnecting client; --after N to start mid-log
```

`GET /meetings/:id/stream?after=<seq>` upgrades to a WebSocket (Hono + Bun).

- `after` defaults to 0. The server sends `ready`, replays every segment with
  `seq > after` in order, then keeps streaming live appends. Replay and live share one
  read path, so a resume has no gap and no duplicate.
- The client owns its cursor: remember the last `seq` you processed and reconnect with
  `?after=<that seq>`. A bad `after` returns 400 and an unknown meeting returns 404, both
  before the upgrade.
- Frames: `ready`, `segment`, `heartbeat`, `error`. A `segment` carries the raw
  `speakerKey` plus a resolved `speaker` (role, label, name, organization, job title)
  when a participant is bound to that key. Email and phone are never sent.
- Close codes: `4409` cursor is ahead of the log head (reset your cursor), `4403` the
  account was removed from the meeting or left it, `1013` the client could not keep up,
  `1011` server error.
- Every tab on a meeting subscribes to the same stream, and each resumes from its own
  `after`.

## Inviting other accounts

The owner of a meeting hands out links; an account that redeems one becomes a `participant`
of that meeting. A link alone grants nothing: redeeming needs a signed-in account.

| Route | Who | |
| --- | --- | --- |
| `POST /meetings/:id/invites` `{expiresInMinutes, maxUses?}` | owner | returns `token` and `url` once; only a hash is stored |
| `GET /meetings/:id/invites`, `DELETE /meetings/:id/invites/:inviteId` | owner | active links, revoke |
| `GET /meetings/:id/members` | owner or participant | everyone in the meeting, host first; email addresses only for the owner |
| `DELETE /meetings/:id/members/:userId` | owner | remove (closes their sockets with `4403`) |
| `POST /invites/redeem` `{token}` | any account | joins; rate limited per account |
| `POST /meetings/:id/leave` | participant | leaves |

- Every failed redeem (unknown, expired, revoked, used up, meeting ended, removed since)
  answers the same `404`. Redeeming again, or as the owner, costs no use. A member the owner
  removed needs a link made after the removal; one who left can use the same link again.
- A participant reads the meeting and its transcript stream, and speaks into it through
  `/meetings/:id/audio`. Ending the meeting, links, members and chats stay owner-only.
- Each microphone is its own Deepgram stream, tagged `user:<userId>` and named through
  `meeting_participants`, and joins the shared timeline at the time it connected. A person
  has one open microphone across all meetings, and a meeting takes at most 6 (owner included).
- `INVITE_LINK_PREFIX` is what the token is appended to in `url`
  (default `interview-assistant://join/`, the scheme the desktop app registers).
