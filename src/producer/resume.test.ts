import { describe, expect, test } from "bun:test";
import { MAX_RESUME_GAP_MS, MIN_RESUME_GAP_MS, planResume } from "./resume";

const NOW = 1_000_000_000_000;

describe("planResume", () => {
  test("a new meeting starts at zero with no gap", () => {
    expect(planResume(null, NOW, { withGap: true })).toEqual({ baseMs: 0, gap: null });
  });

  test("a live resume records the wall-clock break as a gap and continues after it", () => {
    const plan = planResume({ endMs: 60_000, at: NOW - 45_000 }, NOW, { withGap: true });
    expect(plan.gap).toEqual({ startMs: 60_000, endMs: 105_000 });
    expect(plan.baseMs).toBe(105_100);
  });

  test("a break shorter than the minimum is not worth a gap row", () => {
    const plan = planResume({ endMs: 60_000, at: NOW - (MIN_RESUME_GAP_MS - 1) }, NOW, { withGap: true });
    expect(plan).toEqual({ baseMs: 60_100, gap: null });
  });

  test("replays never get a gap, however long the pause", () => {
    const plan = planResume({ endMs: 60_000, at: NOW - 3_600_000 }, NOW, { withGap: false });
    expect(plan).toEqual({ baseMs: 60_100, gap: null });
  });

  test("a very long break is capped so timestamps stay inside 32 bits", () => {
    const plan = planResume({ endMs: 60_000, at: NOW - 30 * 24 * 3_600_000 }, NOW, { withGap: true });
    expect(plan.gap!.endMs - plan.gap!.startMs).toBe(MAX_RESUME_GAP_MS);
    expect(plan.baseMs).toBeLessThan(2 ** 31);
  });
});
