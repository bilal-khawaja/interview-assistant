import { createHash } from "node:crypto";

/** A uuid derived from its parts: the same parts always give the same id. */
export function derivedId(...parts: (string | number)[]): string {
  const hex = createHash("sha256").update(parts.join(":")).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
