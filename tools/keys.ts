// Signing-key files for the CLI. Private keys are only ever written encrypted:
// PKCS#8 bytes sealed with AES-256-GCM under a key derived from a passphrase with scrypt.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { z } from "zod";
import { fromBase64, toBase64 } from "../src/core/bytes";
import { SignerRole, TrustedKey } from "../src/core/schema";
import { generateKeyPair, keyIdFor } from "../src/core/signing";

export const MIN_PASSPHRASE = 12;
const SCRYPT = { N: 1 << 17, r: 8, p: 1 };

export const KeyFile = z
  .object({
    schema: z.literal("tdp-key/0.1"),
    keyId: z.string(),
    name: z.string(),
    roles: z.array(SignerRole).min(1),
    publicKey: z.string(),
    kdf: z.object({ alg: z.literal("scrypt"), N: z.number(), r: z.number(), p: z.number(), salt: z.string() }).strict(),
    cipher: z.object({ alg: z.literal("AES-256-GCM"), iv: z.string(), tag: z.string(), data: z.string() }).strict(),
  })
  .strict();
export type KeyFile = z.infer<typeof KeyFile>;

function deriveKey(passphrase: string, salt: Uint8Array, kdf: { N: number; r: number; p: number }): Buffer {
  return scryptSync(passphrase.normalize("NFC"), salt, 32, { ...kdf, maxmem: 256 * kdf.N * kdf.r });
}

export interface NewKey {
  keyFile: KeyFile;
  /** The entry to add to a trust store. */
  trusted: TrustedKey;
}

export async function createKey(opts: {
  name: string;
  roles: SignerRole[];
  passphrase: string;
  validDays: number;
  now?: Date;
}): Promise<NewKey> {
  if (opts.passphrase.length < MIN_PASSPHRASE) throw new Error(`passphrase must be at least ${MIN_PASSPHRASE} characters`);
  const pair = await generateKeyPair();
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(opts.passphrase, salt, SCRYPT), iv);
  // Bind the ciphertext to the public key so key files can't be spliced together.
  cipher.setAAD(Buffer.from(pair.publicKey));
  const data = Buffer.concat([cipher.update(pkcs8), cipher.final()]);
  pkcs8.fill(0);

  const now = opts.now ?? new Date();
  return {
    keyFile: {
      schema: "tdp-key/0.1",
      keyId: pair.keyId,
      name: opts.name,
      roles: opts.roles,
      publicKey: pair.publicKey,
      kdf: { alg: "scrypt", ...SCRYPT, salt: toBase64(salt) },
      cipher: { alg: "AES-256-GCM", iv: toBase64(iv), tag: toBase64(cipher.getAuthTag()), data: toBase64(data) },
    },
    trusted: {
      keyId: pair.keyId,
      name: opts.name,
      publicKey: pair.publicKey,
      roles: opts.roles,
      notBefore: now.toISOString(),
      notAfter: new Date(now.getTime() + opts.validDays * 86_400_000).toISOString(),
      revoked: false,
    },
  };
}

/** Decrypts a key file into a non-extractable signing key. */
export async function unlockKey(
  json: string,
  passphrase: string,
): Promise<{ keyId: string; name: string; roles: SignerRole[]; privateKey: CryptoKey }> {
  const file = KeyFile.parse(JSON.parse(json));
  if ((await keyIdFor(file.publicKey)) !== file.keyId) throw new Error("key file: key id does not match public key");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveKey(passphrase, fromBase64(file.kdf.salt), file.kdf),
    fromBase64(file.cipher.iv),
  );
  decipher.setAAD(Buffer.from(file.publicKey));
  decipher.setAuthTag(fromBase64(file.cipher.tag));
  let pkcs8: Buffer;
  try {
    pkcs8 = Buffer.concat([decipher.update(fromBase64(file.cipher.data)), decipher.final()]);
  } catch {
    throw new Error("wrong passphrase or corrupted key file");
  }
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, { name: "Ed25519" }, false, ["sign"]);
  pkcs8.fill(0);
  return { keyId: file.keyId, name: file.name, roles: file.roles, privateKey };
}
