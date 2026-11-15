import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { scrypt } from "../src/core/scrypt";
import { unlockKeyFile } from "../src/core/keyfile";
import { signEd25519, verifyEd25519 } from "../src/core/signing";
import { toBase64, toHex, utf8 } from "../src/core/bytes";
import { createKey, unlockKey } from "../tools/keys";

describe("scrypt", () => {
  it("matches Node's implementation", async () => {
    for (const [pw, salt, N, r, p] of [["", "", 16, 1, 1], ["password", "NaCl", 1024, 8, 16], ["pleaseletmein", "SodiumChloride", 16384, 8, 1]] as const) {
      const ours = await scrypt(utf8.encode(pw), utf8.encode(salt), { N, r, p, dkLen: 64 });
      const node = scryptSync(pw, salt, 64, { N, r, p, maxmem: 256 * N * r * p });
      expect(toHex(ours), `${pw}/${N}`).toBe(node.toString("hex"));
    }
  }, 60_000);

  it("refuses unbounded parameters", async () => {
    await expect(scrypt(new Uint8Array(), new Uint8Array(), { N: 3, r: 1, p: 1, dkLen: 32 })).rejects.toThrow(/power of two/);
    await expect(scrypt(new Uint8Array(), new Uint8Array(), { N: 1 << 22, r: 8, p: 1, dkLen: 32 })).rejects.toThrow(/too large/);
  });
});

describe("browser key-file unlock", () => {
  it("opens a CLI key file with WebCrypto only, and rejects a wrong passphrase", async () => {
    const pass = "correct horse battery staple";
    const k = await createKey({ name: "Wanda", roles: [], passphrase: pass, validDays: 30, organization: { name: "Shop" } });
    const unlocked = await unlockKeyFile(JSON.stringify(k.keyFile), pass);
    expect(unlocked.keyId).toBe(k.keyFile.keyId);
    const msg = utf8.encode("hello");
    expect(await verifyEd25519(k.keyFile.publicKey, await signEd25519(unlocked.privateKey, msg), msg)).toBe(true);
    await expect(unlockKeyFile(JSON.stringify(k.keyFile), "wrong passphrase!")).rejects.toThrow(/wrong passphrase/);
  }, 60_000);
});

describe("key files from outside", () => {
  const pass = "correct horse battery staple";

  it("refuse a truncated GCM tag in both the CLI and the browser", async () => {
    const k = await createKey({ name: "Tess", roles: [], passphrase: pass, validDays: 30, organization: { name: "Shop" } });
    const short = { ...k.keyFile, cipher: { ...k.keyFile.cipher, tag: toBase64(Uint8Array.from(atob(k.keyFile.cipher.tag), (c) => c.charCodeAt(0)).slice(0, 4)) } };
    await expect(unlockKeyFile(JSON.stringify(short), pass)).rejects.toThrow(/base64 of 16 bytes/);
    await expect(unlockKey(JSON.stringify(short), pass)).rejects.toThrow(/base64 of 16 bytes/);
  }, 60_000);

  it("refuse scrypt parameters that would exhaust memory before deriving anything", async () => {
    const k = await createKey({ name: "Max", roles: [], passphrase: pass, validDays: 30, organization: { name: "Shop" } });
    for (const kdf of [{ N: 1 << 30 }, { N: 1000 }, { r: 1024 }, { p: 1000 }]) {
      const bad = JSON.stringify({ ...k.keyFile, kdf: { ...k.keyFile.kdf, ...kdf } });
      await expect(unlockKeyFile(bad, pass), JSON.stringify(kdf)).rejects.toThrow();
      await expect(unlockKey(bad, pass), JSON.stringify(kdf)).rejects.toThrow(/scrypt N|too_big|Too big/i);
    }
  }, 60_000);

  it("refuse a file whose encrypted private key isn't the pair of its public key", async () => {
    const real = await createKey({ name: "Ann", roles: [], passphrase: pass, validDays: 30, organization: { name: "Shop" } });
    // Someone who knows the passphrase re-encrypts a different private key under Ann's public key and id.
    const other = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", other.privateKey));
    const N = 1 << 14;
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", scryptSync(pass.normalize("NFC"), salt, 32, { N, r: 8, p: 1, maxmem: 256 * N * 8 }), iv);
    c.setAAD(Buffer.from(real.keyFile.publicKey));
    const data = Buffer.concat([c.update(pkcs8), c.final()]);
    const swapped = JSON.stringify({ ...real.keyFile, kdf: { alg: "scrypt", N, r: 8, p: 1, salt: toBase64(salt) }, cipher: { alg: "AES-256-GCM", iv: toBase64(iv), tag: toBase64(c.getAuthTag()), data: toBase64(data) } });
    await expect(unlockKeyFile(swapped, pass)).rejects.toThrow(/does not match its public key/);
    await expect(unlockKey(swapped, pass)).rejects.toThrow(/does not match its public key/);
  }, 60_000);
});
