import { scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { scrypt } from "../src/core/scrypt";
import { unlockKeyFile } from "../src/core/keyfile";
import { signEd25519, verifyEd25519 } from "../src/core/signing";
import { toHex, utf8 } from "../src/core/bytes";
import { createKey } from "../tools/keys";

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
