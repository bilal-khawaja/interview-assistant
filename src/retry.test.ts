import { describe, expect, test } from "bun:test";
import { LIVE_RETRY } from "./log/append";
import { backoffMs } from "./retry";

describe("backoffMs", () => {
  test("doubles per attempt and caps at the maximum", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => backoffMs(n, 250, 5_000))).toEqual([
      250, 500, 1_000, 2_000, 4_000, 5_000, 5_000,
    ]);
  });

  test("the live retry window rides out a ~40s database outage", () => {
    let total = 0;
    for (let attempt = 1; attempt < LIVE_RETRY.maxAttempts; attempt++) {
      total += backoffMs(attempt, LIVE_RETRY.retryBaseMs, LIVE_RETRY.retryMaxMs);
    }
    expect(total).toBeGreaterThanOrEqual(35_000);
  });
});
