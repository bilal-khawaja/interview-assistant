import { basename, extname } from "node:path";
import {
  DEFAULT_DOCUMENT_ID,
  DEFAULT_QUESTION,
  SAMPLE_TEXT,
} from "../constants/rag";
import { createRag } from "../bootstrap/rag";
import { env } from "../env";

type CommandInput = {
  pdfPath?: string;
  question: string;
};

function parseCommandInput(argv: string[]): CommandInput {
  const args = argv.slice(2);
  const pdfPath = args.find(
    (argument) => extname(argument).toLowerCase() === ".pdf",
  );
  const extraQuestion = args
    .filter((argument) => argument !== pdfPath)
    .join(" ")
    .trim();

  return {
    pdfPath,
    question: DEFAULT_QUESTION + (extraQuestion ? ` ${extraQuestion}` : ""),
  };
}

async function main(): Promise<void> {
  const { pdfPath, question } = parseCommandInput(process.argv);
  const app = createRag();

  try {
    const documentId =
      pdfPath !== undefined
        ? basename(pdfPath, extname(pdfPath))
        : DEFAULT_DOCUMENT_ID;
    const documentText =
      pdfPath !== undefined ? (await app.pdfReader.read(pdfPath)).text : SAMPLE_TEXT;

    const chunks = await app.ingest(documentId, documentText);
    const passages = await app.retrieve(question);

    console.log(`Stored ${chunks.length} chunks in Postgres with pgvector`);
    if (pdfPath !== undefined) {
      console.log(`Loaded PDF: ${pdfPath}`);
    }
    console.log(`\nQuery: ${question}\n`);
    for (const passage of passages) {
      console.log(
        `[${passage.relevance.toFixed(4)}] chunk ${passage.chunkIndex}: ${passage.content}`,
      );
    }

    if (env.STREAM_ANSWER) {
      process.stdout.write("\nAnswer:\n");
      const usage = await app.answer(question, passages, (token) =>
        process.stdout.write(token),
      );
      process.stdout.write(
        `\n\nTokens: input=${usage.inputTokens} output=${usage.outputTokens} total=${usage.totalTokens}\n`,
      );
    }
  } finally {
    await app.close();
  }
}

await main();
