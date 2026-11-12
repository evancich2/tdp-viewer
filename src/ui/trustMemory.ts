import { sha256Hex, utf8 } from "../core/bytes";

// Opt-in: remembers the chosen trust store on this device so the installed app can open .tdp
// files straight from the OS. It's re-validated every time it's loaded, and its fingerprint is
// shown so a change is visible. Storage can be unavailable (private windows, blocked site data),
// so every access is guarded and the app works without it.

const KEY = "tdp-viewer.trust-store";

export interface Remembered {
  json: string;
  label: string;
  /** Pinned roots, when the trust store is signed. */
  anchorsJson?: string;
}

export function recall(): Remembered | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Remembered;
    return typeof v.json === "string" && typeof v.label === "string" && (v.anchorsJson === undefined || typeof v.anchorsJson === "string") ? v : null;
  } catch {
    return null;
  }
}

export function remember(value: Remembered): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function forget(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing stored
  }
}

/** Short, readable fingerprint of a trust store's exact bytes, e.g. "3f2a 91c0 7be4 d815". */
export async function fingerprint(json: string): Promise<string> {
  return (await sha256Hex(utf8.encode(json))).slice(0, 16).match(/.{4}/g)!.join(" ");
}

// Rollback protection: the highest trust-store serial seen from each root on this device. Kept
// whether or not the trust store itself is remembered; it holds no secrets.
const SERIALS = "tdp-viewer.trust-store-serials";

export function seenSerials(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(SERIALS) ?? "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, number] => typeof e[1] === "number"));
  } catch {
    return {};
  }
}

export function recordSerial(rootKeyId: string, serial: number): void {
  try {
    const all = seenSerials();
    if ((all[rootKeyId] ?? 0) < serial) localStorage.setItem(SERIALS, JSON.stringify({ ...all, [rootKeyId]: serial }));
  } catch {
    // storage unavailable: rollback protection lasts for this session only
  }
}
