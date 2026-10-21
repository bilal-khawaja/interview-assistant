/**
 * Follows a fragmented MP4 (DASH audio, as YouTube serves it) as it streams past.
 *
 * Such a file is an init segment (ftyp + moov) followed by fragments (moof + mdat). A
 * decoder can start at any fragment as long as it has seen the init segment first, but not
 * at an arbitrary byte. This tracker splits the stream into those units so a new
 * connection can be given the init segment and then whole fragments.
 *
 * Only ftyp, moov, moof and mdat are forwarded. Index and filler boxes (sidx, free, styp...)
 * are dropped, so what is forwarded is always a clean init segment plus fragments.
 */

export type Fragment = {
  data: Uint8Array;
  /** Position of the fragment among the forwarded fragment bytes, init segment excluded. */
  startMedia: number;
  endMedia: number;
};

export type Pushed = {
  /** The part of this input to send on, or empty. For a non-MP4 stream, the input itself. */
  forward: Uint8Array;
  /** Fragments this input completed. */
  fragments: Fragment[];
};

type Kind = "init" | "fragment" | "skip";

const EMPTY = new Uint8Array(0);

export class Fmp4Tracker {
  /** null until the first bytes decide; false for anything that is not a fragmented MP4. */
  active: boolean | null = null;
  /** Fragment bytes forwarded so far, including a fragment still arriving. */
  mediaBytes = 0;

  private head = new Uint8Array(16);
  private headLen = 0;
  private headNeeded = 8;
  private inBody = false;
  private kind: Kind = "skip";
  private type = "";
  private remaining = 0;
  private boxCount = 0;
  private initParts: Uint8Array[] = [];
  private initFinal = false;
  private fragParts: Uint8Array[] = [];
  private fragStartMedia = 0;

  push(input: Uint8Array): Pushed {
    if (this.active === false) return { forward: input, fragments: [] };
    const forward: Uint8Array[] = [];
    const fragments: Fragment[] = [];
    let i = 0;
    while (i < input.length) {
      if (!this.inBody) {
        this.head[this.headLen++] = input[i++]!;
        if (this.headLen === 8 && new DataView(this.head.buffer).getUint32(0) === 1) {
          this.headNeeded = 16; // the size is 64-bit and follows the type
        }
        if (this.headLen < this.headNeeded) continue;
        if (!this.startBox()) {
          // Not a fragmented MP4: hand everything through untouched from here on.
          this.active = false;
          const head = this.head.slice(0, this.headLen);
          return { forward: concat([...forward, head, input.subarray(i)]), fragments };
        }
        const header = this.head.slice(0, this.headLen);
        this.keep(header, forward);
        this.headLen = 0;
        this.headNeeded = 8;
        if (this.remaining === 0) this.endBox(fragments);
        else this.inBody = true;
        continue;
      }
      const n = Math.min(this.remaining, input.length - i);
      if (this.kind !== "skip") this.keep(input.slice(i, i + n), forward);
      this.remaining -= n;
      i += n;
      if (this.remaining === 0) {
        this.endBox(fragments);
        this.inBody = false;
      }
    }
    return { forward: concat(forward), fragments };
  }

  /** Init segment bytes forwarded so far (complete once the first fragment has started). */
  initBytes(): Uint8Array {
    return concat(this.initParts);
  }

  /** The fragment still arriving: what was forwarded of it, and where it starts. */
  partial(): { data: Uint8Array; startMedia: number } | null {
    if (this.fragParts.length === 0) return null;
    return { data: concat(this.fragParts), startMedia: this.fragStartMedia };
  }

  /** Reads the box header just completed. Returns false if this is not a fragmented MP4. */
  private startBox(): boolean {
    const view = new DataView(this.head.buffer, this.head.byteOffset, 16);
    let size = view.getUint32(0);
    this.type = String.fromCharCode(...this.head.subarray(4, 8));
    if (size === 1) size = Number(view.getBigUint64(8));
    const headerLen = this.headLen;

    if (this.boxCount++ === 0 && this.type !== "ftyp" && this.type !== "styp") return false;
    if (size !== 0 && size < headerLen) return false;
    this.remaining = size === 0 ? Number.POSITIVE_INFINITY : size - headerLen;

    if (this.type === "ftyp" || this.type === "moov") {
      if (this.initFinal) return false;
      this.kind = "init";
    } else if (this.type === "moof") {
      this.initFinal = true;
      this.kind = "fragment";
      this.fragParts = [];
      this.fragStartMedia = this.mediaBytes;
    } else if (this.type === "mdat") {
      // An mdat with no moof before it is a plain MP4: it cannot be resumed mid-file.
      if (this.fragParts.length === 0) return false;
      this.kind = "fragment";
    } else {
      this.kind = "skip";
    }
    this.active = true;
    return true;
  }

  private keep(bytes: Uint8Array, forward: Uint8Array[]): void {
    if (this.kind === "skip") return;
    forward.push(bytes);
    if (this.kind === "init") {
      this.initParts.push(bytes);
    } else {
      this.fragParts.push(bytes);
      this.mediaBytes += bytes.length;
    }
  }

  private endBox(fragments: Fragment[]): void {
    if (this.kind === "fragment" && this.type === "mdat") {
      fragments.push({
        data: concat(this.fragParts),
        startMedia: this.fragStartMedia,
        endMedia: this.mediaBytes,
      });
      this.fragParts = [];
    }
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 0) return EMPTY;
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
