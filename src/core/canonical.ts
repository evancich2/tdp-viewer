import { sha256Hex, utf8 } from "./bytes";

/**
 * Canonical JSON per RFC 8785 (JCS): member names sorted by UTF-16 code units, no whitespace,
 * numbers in ECMAScript shortest round-trip form (which JSON.stringify writes), strings escaped as
 * JSON.stringify escapes them. Signed records, transactions and metadata are hashed in this form,
 * so the same content has the same digest whatever key order or whitespace a file was written
 * with, and any RFC 8785 implementation (Python, Go, Java...) computes the same digest. Original
 * files (CAD, drawings, photos, logs) are never canonicalized: they are hashed as raw bytes.
 * Only plain JSON values are accepted; lone surrogates are refused, as RFC 8785 requires.
 * See docs/canonical-json.md.
 */
export function canonicalJson(value: unknown): string {
  if (typeof value === "string") return jcsString(value);
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    // map() skips holes, and join() would write [1,,2], which isn't JSON.
    for (let i = 0; i < value.length; i++) if (!(i in value)) throw new Error("canonical JSON: sparse array");
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error("canonical JSON: not a plain object");
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${jcsString(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new Error(`canonical JSON: unsupported ${typeof value}`);
}

function jcsString(s: string): string {
  if (/\p{Surrogate}/u.test(s)) throw new Error("canonical JSON: lone UTF-16 surrogate in a string");
  return JSON.stringify(s);
}

export const canonicalSha256 = (value: unknown) => sha256Hex(utf8.encode(canonicalJson(value)));
