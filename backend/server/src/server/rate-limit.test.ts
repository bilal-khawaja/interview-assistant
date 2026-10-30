import { describe, expect, test } from "bun:test";
import { RateLimiter } from "./rate-limit";

describe("RateLimiter", () => {
  test("allows up to the limit per key in a window, then refuses", () => {
    const limiter = new RateLimiter(3, 1_000);
    expect([1, 2, 3, 4].map(() => limiter.allow("a", 0))).toEqual([true, true, true, false]);
    expect(limiter.allow("b", 0)).toBe(true);
  });

  test("starts a fresh window once the old one has passed", () => {
    const limiter = new RateLimiter(1, 1_000);
    expect(limiter.allow("a", 0)).toBe(true);
    expect(limiter.allow("a", 999)).toBe(false);
    expect(limiter.allow("a", 1_000)).toBe(true);
  });
});
