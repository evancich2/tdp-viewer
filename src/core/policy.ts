import type { SignerRole } from "./schema";

/**
 * Verification policy. Everything not explicitly allowed here is denied.
 * The policy comes from the viewer's operator, never from the package being checked.
 */
export interface Policy {
  /** Every one of these roles must be covered by a valid signature from a distinct key. */
  requiredRoles: SignerRole[];
  /** Media types the viewer will accept, mapped to a content check on the file's leading bytes. */
  allowedMediaTypes: Record<string, MagicCheck>;
  limits: {
    maxEntries: number;
    maxFileBytes: number;
    maxTotalBytes: number;
    /** Rejects zip bombs: uncompressed / compressed for any single entry. */
    maxCompressionRatio: number;
  };
  /** Allowed clock skew when checking validity windows, in milliseconds. */
  clockSkewMs: number;
}

export type MagicCheck = (head: Uint8Array) => boolean;

const startsWith = (prefix: string): MagicCheck => (head) => {
  if (head.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (head[i] !== prefix.charCodeAt(i)) return false;
  return true;
};

const isUtf8Text: MagicCheck = (head) => {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head);
    return !head.includes(0);
  } catch {
    return false;
  }
};

export const defaultPolicy: Policy = {
  requiredRoles: ["author", "approver"],
  allowedMediaTypes: {
    "application/pdf": startsWith("%PDF-"),
    "model/step": startsWith("ISO-10303-21;"),
    "application/json": isUtf8Text,
    "text/csv": isUtf8Text,
    "text/plain": isUtf8Text,
  },
  limits: {
    maxEntries: 2_000,
    maxFileBytes: 512 * 1024 * 1024,
    maxTotalBytes: 2 * 1024 * 1024 * 1024,
    maxCompressionRatio: 200,
  },
  clockSkewMs: 5 * 60 * 1000,
};
