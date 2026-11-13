import { z } from "zod";
import { fromBase64, sha256Hex, toBase64, utf8 } from "./bytes";
import { TrustStore } from "./schema";
import { keyIdFor, signWith, type KeyHandle, verifyEd25519 } from "./signing";
import { loadTrustStore } from "./verify";

// Signed trust stores. An organization's root key signs the trust store; viewers pin the root
// (the "anchors" file) instead of vetting every signer key by hand. Each signed release carries
// a serial number so an old store (say, from before a key was revoked) can't be replayed.

const keyId = z.string().regex(/^[0-9a-f]{32}$/);
const isoTime = z.string().datetime({ offset: true });

export const RootKey = z.object({ keyId, name: z.string().min(1).max(200), publicKey: z.string().min(1).max(100) }).strict();
export type RootKey = z.infer<typeof RootKey>;

/** The roots a viewer trusts to sign trust stores. Pinned by the operator, never taken from a package. */
export const Anchors = z.object({ schema: z.literal("tdp-anchors/0.1"), roots: z.array(RootKey).min(1).max(16) }).strict();
export type Anchors = z.infer<typeof Anchors>;

export const SignedTrustStore = z
  .object({
    schema: z.literal("tdp-signed-truststore/0.1"),
    /** Base64 of the exact trust-store JSON bytes that were signed. */
    payload: z.string().min(1).max(2_000_000),
    signatures: z
      .array(z.object({ keyId, alg: z.literal("Ed25519"), signedAt: isoTime, sig: z.string().min(1).max(200) }).strict())
      .min(1)
      .max(8),
  })
  .strict();
export type SignedTrustStore = z.infer<typeof SignedTrustStore>;

export function trustStoreSigningMessage(payloadSha256: string, signedAt: string): Uint8Array {
  return utf8.encode(`tdp-truststore-signature/0.1\n${signedAt}\n${payloadSha256}`);
}

export async function loadAnchors(json: string): Promise<Anchors> {
  const anchors = Anchors.parse(JSON.parse(json));
  for (const root of anchors.roots)
    if ((await keyIdFor(root.publicKey)) !== root.keyId) throw new Error(`anchors: key id mismatch for ${root.name}`);
  return anchors;
}

export interface LoadedTrustStore {
  store: TrustStore;
  /** Set when the store was signed by a pinned root. */
  signedBy?: RootKey;
}

export interface LoadOptions {
  anchors?: Anchors;
  now?: Date;
  /** Highest serial already seen from each root, for rollback protection. */
  seenSerials?: Record<string, number>;
}

/**
 * Loads a trust store file, signed or plain.
 * - Signed: needs a valid signature from a pinned root, a serial no lower than any already seen
 *   from that root, and an expiry still in the future.
 * - Plain: accepted only when no roots are pinned. Once you pin a root, unsigned stores are refused,
 *   so nobody can downgrade you to an unsigned one.
 */
export async function loadTrustStoreFile(json: string, opts: LoadOptions = {}): Promise<LoadedTrustStore> {
  const now = opts.now ?? new Date();
  const raw = JSON.parse(json) as { schema?: unknown };
  if (raw.schema !== "tdp-signed-truststore/0.1") {
    if (opts.anchors) throw new Error("this trust store isn't signed, and you've pinned a root key: only signed trust stores are accepted");
    return { store: await loadTrustStore(json) };
  }

  const signed = SignedTrustStore.parse(raw);
  if (!opts.anchors) throw new Error("this trust store is signed; load the organization's root key (anchors file) to check it");
  const payload = fromBase64(signed.payload);
  const digest = await sha256Hex(payload);
  let signedBy: RootKey | undefined;
  for (const sig of signed.signatures) {
    const root = opts.anchors.roots.find((r) => r.keyId === sig.keyId);
    if (root && (await verifyEd25519(root.publicKey, sig.sig, trustStoreSigningMessage(digest, sig.signedAt)))) {
      signedBy = root;
      break;
    }
  }
  if (!signedBy) {
    const ids = signed.signatures.map((s) => s.keyId).join(", ");
    throw new Error(`no valid signature from a pinned root (signed by ${ids})`);
  }

  const store = await loadTrustStore(utf8.decode(payload));
  if (!store.serial) throw new Error("signed trust store has no serial number");
  if (!store.expires) throw new Error("signed trust store has no expiry");
  if (Date.parse(store.expires) < now.getTime()) throw new Error(`trust store expired ${store.expires}`);
  const seen = opts.seenSerials?.[signedBy.keyId] ?? 0;
  if (store.serial < seen)
    throw new Error(`trust store serial ${store.serial} is older than serial ${seen} already seen from ${signedBy.name} (possible rollback)`);
  return { store, signedBy };
}

/** Signs a trust store as a root. Stamps serial, issuer and validity into the signed bytes. */
export async function signTrustStore(
  store: TrustStore,
  root: KeyHandle & { name: string },
  opts: { serial: number; validDays: number; now?: Date },
): Promise<SignedTrustStore> {
  const now = opts.now ?? new Date();
  const stamped: TrustStore = {
    ...TrustStore.parse(store),
    serial: opts.serial,
    issuer: root.name,
    issued: now.toISOString(),
    expires: new Date(now.getTime() + opts.validDays * 86_400_000).toISOString(),
  };
  const payload = utf8.encode(JSON.stringify(stamped, null, 2));
  const signedAt = now.toISOString();
  const sig = await signWith(root, trustStoreSigningMessage(await sha256Hex(payload), signedAt));
  return {
    schema: "tdp-signed-truststore/0.1",
    payload: toBase64(payload),
    signatures: [{ keyId: root.keyId, alg: "Ed25519", signedAt, sig }],
  };
}
