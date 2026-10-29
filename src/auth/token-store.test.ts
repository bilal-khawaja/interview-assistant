import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeStorageTokenStore, type TokenCrypto } from './token-store';

/** Not real encryption: enough to prove the file never holds the token as written. */
function fakeCrypto(available = true): TokenCrypto {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(plain, 'utf8').reverse(),
    decryptString: (encrypted) => Buffer.from(encrypted).reverse().toString('utf8'),
  };
}

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-store-'));
  file = path.join(dir, 'nested', 'session.bin');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('SafeStorageTokenStore', () => {
  test('saves the token encrypted and loads it back', () => {
    const store = new SafeStorageTokenStore(() => file, fakeCrypto());
    expect(store.save('secret-token-123')).toBe(true);
    expect(fs.readFileSync(file).toString('utf8')).not.toContain('secret-token-123');
    expect(new SafeStorageTokenStore(() => file, fakeCrypto()).load()).toBe('secret-token-123');
  });

  test('without encryption the token is never written, and an old file is removed', () => {
    new SafeStorageTokenStore(() => file, fakeCrypto()).save('old-token');
    const store = new SafeStorageTokenStore(() => file, fakeCrypto(false));
    expect(store.save('new-token')).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    expect(store.load()).toBeNull();
  });

  test('a missing, empty or unreadable file is no token', () => {
    const store = new SafeStorageTokenStore(() => file, fakeCrypto());
    expect(store.load()).toBeNull();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    expect(store.load()).toBeNull();
    const broken: TokenCrypto = {
      ...fakeCrypto(),
      decryptString: () => {
        throw new Error('cannot decrypt');
      },
    };
    fs.writeFileSync(file, 'garbage');
    expect(new SafeStorageTokenStore(() => file, broken).load()).toBeNull();
  });

  test('clear removes the file and is safe to repeat', () => {
    const store = new SafeStorageTokenStore(() => file, fakeCrypto());
    store.save('t');
    store.clear();
    store.clear();
    expect(fs.existsSync(file)).toBe(false);
    expect(store.load()).toBeNull();
  });
});
