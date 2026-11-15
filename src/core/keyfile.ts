import { z } from "zod";
import { fromBase64, utf8 } from "./bytes";
import { SignerRole } from "./schema";
import { scrypt } from "./scrypt";
import { keyIdFor, signEd25519, verifyEd25519 } from "./signing";
import { parseJson } from "./json";

// The encrypted key-file format written by `tdp keygen` (tools/keys.ts), and a WebCrypto-only way
// to open one, so the viewer can sign workflow records. The private key is imported non-extractable
// and lives only in memory for the session; nothing is stored or sent.

/**
 * A key is a package signer (author, checker, approver, release), an organization root that signs
 * trust stores and configuration, or, with no roles at all, a workflow-record signer whose workflow
 * roles come from the authority configuration rather than from the key.
 */
export const KeyRole = z.union([SignerRole, z.literal("root")]);
export type KeyRole = z.infer<typeof KeyRole>;

/** Base64 that decodes to between `min` and `max` bytes. */
const b64 = (min: number, max: number) =>
  z.string().max(4 * Math.ceil(max / 3)).refine((s) => {
    try { const n = fromBase64(s).length; return n >= min && n <= max; } catch { return false; }
  }, `must be base64 of ${min === max ? min : `${min}–${max}`} bytes`);

/**
 * Signs a probe and checks it against the file's public key, so a key file whose encrypted private
 * key doesn't belong to its declared public key (and key id) is refused before anything is signed.
 */
export async function assertKeyPair(privateKey: CryptoKey, publicKey: string): Promise<void> {
  const probe = utf8.encode("tdp-key-pair-check/0.1");
  if (!(await verifyEd25519(publicKey, await signEd25519(privateKey, probe), probe))) throw new Error("key file: the private key does not match its public key");
}

export const KeyFile = z
  .object({
    schema: z.literal("tdp-key/0.1"),
    keyId: z.string(),
    name: z.string(),
    roles: z.array(KeyRole).max(8),
    publicKey: z.string(),
    // Bounded so a crafted key file can't make unlocking allocate gigabytes (128·N·r bytes per lane).
    kdf: z
      .object({
        alg: z.literal("scrypt"),
        N: z.number().int().min(2).max(1 << 20).refine((n) => (n & (n - 1)) === 0, "scrypt N must be a power of two"),
        r: z.number().int().min(1).max(32),
        p: z.number().int().min(1).max(16),
        salt: b64(16, 64),
      })
      .strict(),
    // A 96-bit IV and a full 128-bit tag: a truncated GCM tag is refused rather than accepted.
    cipher: z.object({ alg: z.literal("AES-256-GCM"), iv: b64(12, 12), tag: b64(16, 16), data: b64(1, 256) }).strict(),
  })
  .strict();
export type KeyFile = z.infer<typeof KeyFile>;

export interface UnlockedKey {
  keyId: string;
  name: string;
  roles: KeyRole[];
  privateKey: CryptoKey;
}

/** Opens a key file with WebCrypto (and the scrypt above). Same result as the CLI's unlockKey. */
export async function unlockKeyFile(json: string, passphrase: string): Promise<UnlockedKey> {
  const file = KeyFile.parse(parseJson(json));
  if ((await keyIdFor(file.publicKey)) !== file.keyId) throw new Error("key file: key id does not match public key");
  const raw = await scrypt(utf8.encode(passphrase.normalize("NFC")), fromBase64(file.kdf.salt), { N: file.kdf.N, r: file.kdf.r, p: file.kdf.p, dkLen: 32 });
  const aes = await crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["decrypt"]);
  raw.fill(0);
  const sealed = new Uint8Array([...fromBase64(file.cipher.data), ...fromBase64(file.cipher.tag)]);
  let pkcs8: Uint8Array;
  try {
    pkcs8 = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(file.cipher.iv) as BufferSource, additionalData: utf8.encode(file.publicKey) as BufferSource }, aes, sealed as BufferSource));
  } catch {
    throw new Error("wrong passphrase or corrupted key file");
  }
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, { name: "Ed25519" }, false, ["sign"]);
  pkcs8.fill(0);
  await assertKeyPair(privateKey, file.publicKey);
  return { keyId: file.keyId, name: file.name, roles: file.roles, privateKey };
}
