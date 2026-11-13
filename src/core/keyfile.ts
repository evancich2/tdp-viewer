import { z } from "zod";
import { fromBase64, utf8 } from "./bytes";
import { SignerRole } from "./schema";
import { scrypt } from "./scrypt";
import { keyIdFor } from "./signing";

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

export interface UnlockedKey {
  keyId: string;
  name: string;
  roles: KeyRole[];
  privateKey: CryptoKey;
}

/** Opens a key file with WebCrypto (and the scrypt above). Same result as the CLI's unlockKey. */
export async function unlockKeyFile(json: string, passphrase: string): Promise<UnlockedKey> {
  const file = KeyFile.parse(JSON.parse(json));
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
  return { keyId: file.keyId, name: file.name, roles: file.roles, privateKey };
}
