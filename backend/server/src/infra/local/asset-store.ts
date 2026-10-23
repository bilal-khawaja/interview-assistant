import { readFile } from "node:fs/promises";
import type * as Port from "../../core/ports";

export class AssetStore implements Port.AssetStore {
  async read(path: string): Promise<Uint8Array> {
    return readFile(path);
  }
}
