import { sha256Hex, utf8 } from "../core/bytes";

// Opt-in: remembers the chosen trust store on this device so the installed app can open .tdp
// files straight from the OS. It's re-validated every time it's loaded, and its fingerprint is
// shown so a change is visible. Storage can be unavailable (private windows, blocked site data),
// so every access is guarded and the app works without it.

const KEY = "tdp-viewer.trust-store";

export interface Remembered {
  json: string;
  label: string;
}

export function recall(): Remembered | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Remembered;
    return typeof v.json === "string" && typeof v.label === "string" ? v : null;
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
