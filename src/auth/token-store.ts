import fs from 'node:fs';
import path from 'node:path';

/** The part of Electron's safeStorage the store needs, so tests can stand in for it. */
export interface TokenCrypto {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface TokenStore {
  load(): string | null;
  /** Returns false when the token could not be kept safely; it then lives in memory only. */
  save(token: string): boolean;
  clear(): void;
}

/**
 * Keeps the session token encrypted with the operating system's keystore (Electron
 * safeStorage) in a file in the user-data folder. When encryption is unavailable the token
 * is never written in plain text: it is simply not saved, and the user signs in again on the
 * next launch. A file that cannot be decrypted is treated as no token.
 */
export class SafeStorageTokenStore implements TokenStore {
  constructor(
    private readonly filePath: () => string,
    private readonly crypto: TokenCrypto,
  ) {}

  load(): string | null {
    try {
      if (!this.crypto.isEncryptionAvailable()) return null;
      const token = this.crypto.decryptString(fs.readFileSync(this.filePath()));
      return token || null;
    } catch {
      return null;
    }
  }

  save(token: string): boolean {
    try {
      if (!this.crypto.isEncryptionAvailable()) {
        this.clear();
        return false;
      }
      const file = this.filePath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, this.crypto.encryptString(token), { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  clear(): void {
    try {
      fs.rmSync(this.filePath(), { force: true });
    } catch {
      // nothing to remove
    }
  }
}
