import { describe, expect, test } from 'bun:test';
import { backoffDelay, normalizeBackendUrl, toWebSocketUrl } from './backend-url';

describe('backend url', () => {
  test('normalizes whitespace and trailing slashes', () => {
    expect(normalizeBackendUrl('  http://localhost:3000/// ')).toBe('http://localhost:3000');
    expect(normalizeBackendUrl('https://api.example.com/base/')).toBe('https://api.example.com/base');
  });

  test('rejects anything that is not http(s)', () => {
    expect(() => normalizeBackendUrl('ws://localhost:3000')).toThrow();
    expect(() => normalizeBackendUrl('localhost:3000')).toThrow();
    expect(() => normalizeBackendUrl('')).toThrow();
  });

  test('maps http to ws and https to wss', () => {
    expect(toWebSocketUrl('http://localhost:3000')).toBe('ws://localhost:3000');
    expect(toWebSocketUrl('https://x.example')).toBe('wss://x.example');
  });

  test('backoff grows, caps, and stays within jitter bounds', () => {
    expect(backoffDelay(1, 100, 1000, () => 1)).toBe(100);
    expect(backoffDelay(3, 100, 1000, () => 1)).toBe(400);
    expect(backoffDelay(20, 100, 1000, () => 1)).toBe(1000);
    expect(backoffDelay(20, 100, 1000, () => 0)).toBe(750);
  });
});
