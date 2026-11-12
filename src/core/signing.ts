import { fromBase64, sha256Hex, toBase64 } from "./bytes";

// Ed25519 through WebCrypto. Public keys travel as base64 of the 32 raw bytes.

/** A key's id is derived from the key itself, so a package can't claim someone else's id. */
export async function keyIdFor(publicKeyB64: string): Promise<string> {
  return (await sha256Hex(fromBase64(publicKeyB64))).slice(0, 32);
}

export async function importPublicKey(publicKeyB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromBase64(publicKeyB64) as BufferSource, { name: "Ed25519" }, false, [
    "verify",
  ]);
}

export async function verifyEd25519(publicKeyB64: string, sigB64: string, message: Uint8Array): Promise<boolean> {
  try {
    const key = await importPublicKey(publicKeyB64);
    return await crypto.subtle.verify("Ed25519", key, fromBase64(sigB64) as BufferSource, message as BufferSource);
  } catch {
    return false;
  }
}

export interface KeyPair {
  keyId: string;
  publicKey: string;
  privateKey: CryptoKey;
}

export async function generateKeyPair(): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const publicKey = toBase64(raw);
  return { keyId: await keyIdFor(publicKey), publicKey, privateKey: pair.privateKey };
}

export async function signEd25519(privateKey: CryptoKey, message: Uint8Array): Promise<string> {
  return toBase64(new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, message as BufferSource)));
}
