import { describe, expect, test } from "bun:test";
import { isTransientDbError } from "./transient";

describe("isTransientDbError", () => {
  test("recognises Bun and Node connection failures, including wrapped ones", () => {
    expect(isTransientDbError({ code: "ERR_POSTGRES_CONNECTION_CLOSED" })).toBe(true);
    expect(isTransientDbError({ code: "ERR_POSTGRES_CONNECTION_REFUSED" })).toBe(true);
    expect(isTransientDbError({ code: "ECONNRESET" })).toBe(true);
    expect(isTransientDbError({ errno: "57P01" })).toBe(true);
    expect(isTransientDbError({ errno: "08006" })).toBe(true);
    expect(isTransientDbError(new Error("Failed query", { cause: { code: "ERR_POSTGRES_CONNECTION_CLOSED" } }))).toBe(true);
  });

  test("data errors are not transient", () => {
    expect(isTransientDbError({ errno: "23505" })).toBe(false); // unique violation
    expect(isTransientDbError({ errno: "42P01" })).toBe(false); // missing table
    expect(isTransientDbError(new Error("connection reset"))).toBe(false); // unclassified
    expect(isTransientDbError(null)).toBe(false);
  });
});
