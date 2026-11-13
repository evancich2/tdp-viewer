// Signing-key files for the CLI. Private keys are only ever written encrypted:
// PKCS#8 bytes sealed with AES-256-GCM under a key derived from a passphrase with scrypt.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { z } from "zod";
import { fromBase64, toBase64 } from "../src/core/bytes";
import { Organization, SignerRole, TrustedKey } from "../src/core/schema";
import type { RootKey } from "../src/core/truststore";
import { generateKeyPair, keyIdFor } from "../src/core/signing";

export const MIN_PASSPHRASE = 12;
const SCRYPT = { N: 1 << 17, r: 8, p: 1 };

/**
 * A key is a package signer (author, checker, approver, release), an organization root that signs
 * trust stores and configuration, or, with no roles at all, a workflow-record signer whose workflow
 * roles come from the authority configuration rather than from the key.
 */
export const KeyRole = z.union([SignerRole, z.literal("root")]);
export type KeyRole = z.infer<typeof KeyRole>;

export const KeyFile = z
  .object({
    schema: z.literal("tdp-key/0.1"),
    keyId: z.string(),
    name: z.string(),
    roles: z.array(KeyRole).max(8),
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
  /** For signer keys: the entry to add to a trust store. For a root key: the entry to pin in an anchors file. */
  trusted: TrustedKey | RootKey;
}

export async function createKey(opts: {
  name: string;
  roles: KeyRole[];
  passphrase: string;
  validDays: number;
  /** The organization the holder acts for; goes into the trust-store entry. */
  organization?: Organization;
  now?: Date;
}): Promise<NewKey> {
  if (opts.passphrase.length < MIN_PASSPHRASE) throw new Error(`passphrase must be at least ${MIN_PASSPHRASE} characters`);
  const isRoot = opts.roles.includes("root");
  // Keep root keys single-purpose: a root that also signed packages would be a bigger target.
  if (isRoot && opts.roles.length > 1) throw new Error("a root key can't also have package-signing roles");
  if (!opts.roles.length && !opts.organization) throw new Error("a workflow-only key (no signing roles) needs an organization");
  const organization = opts.organization ? Organization.parse(opts.organization) : undefined;
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
    trusted: isRoot
      ? { keyId: pair.keyId, name: opts.name, publicKey: pair.publicKey }
      : {
          keyId: pair.keyId,
          name: opts.name,
          ...(organization ? { organization } : {}),
          publicKey: pair.publicKey,
          roles: opts.roles as SignerRole[],
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
): Promise<{ keyId: string; name: string; roles: KeyRole[]; privateKey: CryptoKey }> {
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
