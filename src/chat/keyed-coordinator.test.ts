import { describe, expect, test } from "bun:test";
import { KeyedCoordinator } from "./keyed-coordinator";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("KeyedCoordinator", () => {
  test("runs tasks for one key strictly in submission order", async () => {
    const c = new KeyedCoordinator();
    const log: string[] = [];
    const task = (name: string, ms: number) => async () => {
      log.push(`start ${name}`);
      await sleep(ms);
      log.push(`end ${name}`);
    };
    await Promise.all([c.run("a", task("1", 30)), c.run("a", task("2", 1)), c.run("a", task("3", 1))]);
    expect(log).toEqual(["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
  });

  test("different keys run concurrently", async () => {
    const c = new KeyedCoordinator();
    let running = 0;
    let peak = 0;
    const task = async () => {
      peak = Math.max(peak, ++running);
      await sleep(20);
      running--;
    };
    await Promise.all([c.run("a", task), c.run("b", task), c.run("c", task)]);
    expect(peak).toBe(3);
  });

  test("a failed task rejects its caller only; the queue keeps going", async () => {
    const c = new KeyedCoordinator();
    const failing = c.run("a", async () => {
      throw new Error("boom");
    });
    const after = c.run("a", async () => "ok");
    await expect(failing).rejects.toThrow("boom");
    await expect(after).resolves.toBe("ok");
  });

  test("returns each task's own result", async () => {
    const c = new KeyedCoordinator();
    const results = await Promise.all([1, 2, 3].map((n) => c.run("k", async () => n * 2)));
    expect(results).toEqual([2, 4, 6]);
  });

  test("forgets a key once its queue drains", async () => {
    const c = new KeyedCoordinator();
    await c.run("a", async () => 1);
    await sleep(0);
    expect(c.active).toBe(0);
    const pending = c.run("a", () => sleep(20));
    expect(c.active).toBe(1);
    await pending;
  });

  test("idle waits for queued work", async () => {
    const c = new KeyedCoordinator();
    let done = false;
    void c.run("a", async () => {
      await sleep(20);
      done = true;
    });
    await c.idle("a");
    expect(done).toBe(true);
  });
});
