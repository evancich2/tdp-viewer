import { unzipSync } from "fflate";
import type { Policy } from "./policy";

export interface ArchiveEntry {
  path: string;
  bytes: Uint8Array;
}

export class ArchiveError extends Error {}

/**
 * Rejects paths that could escape the package or collide with each other:
 * absolute paths, "..", backslashes, control characters, and empty segments.
 */
export function checkPath(path: string): string | null {
  if (path.length === 0 || path.length > 255) return "path length out of range";
  if (path.startsWith("/")) return "absolute path";
  if (path.includes("\\")) return "backslash in path";
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(path)) return "control character in path";
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return "relative or empty path segment";
  if (/^[A-Za-z]:/.test(path)) return "drive letter in path";
  return null;
}

/**
 * Unzips a package while enforcing the policy's size limits.
 * Limits are checked on the declared sizes before inflating and again on the real sizes after,
 * because zip headers are attacker-controlled.
 */
export function readArchive(data: Uint8Array, policy: Policy): ArchiveEntry[] {
  const { maxEntries, maxFileBytes, maxTotalBytes, maxCompressionRatio } = policy.limits;
  let count = 0;
  let declaredTotal = 0;
  let problem: string | null = null;

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, {
      filter(file) {
        if (problem) return false;
        if (file.name.endsWith("/")) return false; // directory entry, carries no data
        count++;
        declaredTotal += file.originalSize;
        const pathProblem = checkPath(file.name);
        if (pathProblem) problem = `${file.name}: ${pathProblem}`;
        else if (count > maxEntries) problem = `more than ${maxEntries} entries`;
        else if (file.originalSize > maxFileBytes) problem = `${file.name}: larger than ${maxFileBytes} bytes`;
        else if (declaredTotal > maxTotalBytes) problem = `package larger than ${maxTotalBytes} bytes`;
        else if (file.size > 0 && file.originalSize / file.size > maxCompressionRatio)
          problem = `${file.name}: compression ratio above ${maxCompressionRatio}`;
        return problem === null;
      },
    });
  } catch (e) {
    throw new ArchiveError(`not a readable zip: ${(e as Error).message}`);
  }
  if (problem) throw new ArchiveError(problem);

  const entries: ArchiveEntry[] = [];
  const seen = new Set<string>();
  let realTotal = 0;
  for (const [path, bytes] of Object.entries(files)) {
    // Case-insensitive duplicates can map to the same file on some filesystems.
    const key = path.normalize("NFC").toLowerCase();
    if (seen.has(key)) throw new ArchiveError(`${path}: duplicate entry`);
    seen.add(key);
    if (bytes.length > maxFileBytes) throw new ArchiveError(`${path}: larger than ${maxFileBytes} bytes`);
    realTotal += bytes.length;
    if (realTotal > maxTotalBytes) throw new ArchiveError(`package larger than ${maxTotalBytes} bytes`);
    entries.push({ path, bytes });
  }
  return entries;
}
