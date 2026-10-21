import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  fstatSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export type SpoolRow = {
  seq: number;
  speakerKey: string | null;
  text: string;
  startMs: number;
  endMs: number;
  source: string;
};

export type SpoolContents = {
  rows: SpoolRow[];
  /** Lines that could not be read, such as a write cut short by a crash. */
  skipped: number;
};

/**
 * Write-ahead log for one meeting: one JSON line per accepted row, written to disk
 * before the database write is attempted. If the process dies while the database is
 * unreachable, the next producer for the meeting replays what the database lacks.
 */
export class SegmentSpool {
  readonly path: string;
  private fd: number | null = null;
  // Writes go to an explicit offset on a read-write handle: Windows refuses to
  // truncate a handle opened in append mode.
  private offset = 0;

  constructor(
    dir: string,
    meetingId: string,
    private readonly sync: boolean = true,
  ) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, `${meetingId}.ndjson`);
  }

  read(): SpoolContents {
    if (!existsSync(this.path)) return { rows: [], skipped: 0 };
    const rows: SpoolRow[] = [];
    let skipped = 0;
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = parseRow(line);
      if (row) rows.push(row);
      else skipped++;
    }
    return { rows, skipped };
  }

  /** When the file was last written, in epoch ms. 0 if it does not exist. */
  modifiedAt(): number {
    return existsSync(this.path) ? statSync(this.path).mtimeMs : 0;
  }

  append(row: SpoolRow): void {
    const fd = this.open();
    const bytes = Buffer.from(`${JSON.stringify(row)}\n`);
    writeSync(fd, bytes, 0, bytes.length, this.offset);
    this.offset += bytes.length;
    if (this.sync) fsyncSync(fd);
  }

  /** Call only when the database holds every row in the file. */
  reset(): void {
    if (this.fd === null && !existsSync(this.path)) return;
    ftruncateSync(this.open(), 0);
    this.offset = 0;
  }

  close(): void {
    if (this.fd === null) return;
    closeSync(this.fd);
    this.fd = null;
  }

  private open(): number {
    if (this.fd !== null) return this.fd;
    closeSync(openSync(this.path, "a")); // create it if missing
    const fd = openSync(this.path, "r+");
    const size = fstatSync(fd).size;
    this.offset = size;
    if (size > 0) {
      // a crash can leave a half-written last line; start the next row on a fresh line
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) {
        writeSync(fd, "\n", size);
        this.offset = size + 1;
      }
    }
    this.fd = fd;
    return fd;
  }
}

function parseRow(line: string): SpoolRow | null {
  try {
    const row = JSON.parse(line) as Partial<SpoolRow>;
    if (
      Number.isInteger(row.seq) &&
      typeof row.text === "string" &&
      Number.isInteger(row.startMs) &&
      Number.isInteger(row.endMs) &&
      typeof row.source === "string"
    ) {
      return {
        seq: row.seq!,
        speakerKey: row.speakerKey ?? null,
        text: row.text,
        startMs: row.startMs!,
        endMs: row.endMs!,
        source: row.source,
      };
    }
  } catch {
    return null;
  }
  return null;
}
