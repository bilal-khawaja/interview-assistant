export interface AssetStore {
  read(path: string): Promise<Uint8Array>;
}
