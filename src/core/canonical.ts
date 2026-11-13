import { sha256Hex, utf8 } from "./bytes";

/**
 * Deterministic JSON: object keys sorted, no whitespace, numbers as JSON.stringify writes them.
 * Signed records and transactions are hashed in this form so the same content always has the same
 * digest regardless of how a file was pretty-printed. Only plain JSON values are accepted.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error("canonical JSON: not a plain object");
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new Error(`canonical JSON: unsupported ${typeof value}`);
}

export const canonicalSha256 = (value: unknown) => sha256Hex(utf8.encode(canonicalJson(value)));
