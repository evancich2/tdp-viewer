import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { defaultPolicy, verifyPackage, type TrustStore } from "../src/core";
import { utf8 } from "../src/core/bytes";
import { SPEC_FILE, addToTrustStore, pack, revokeInTrustStore, sign } from "../tools/commands";
import { createKey, unlockKey, type NewKey } from "../tools/keys";
import { samplePdf } from "../tools/sample-data";
import { writeStep } from "../tools/step-writer";

const now = new Date("2026-06-01T00:00:00Z");
const later = new Date("2026-06-02T00:00:00Z");
const PASS = "correct horse battery staple";

let author: NewKey;
let approver: NewKey;
let store: TrustStore;
let folder: string;

beforeAll(async () => {
  [author, approver] = await Promise.all([
    createKey({ name: "Ann Author", roles: ["author"], passphrase: PASS, validDays: 365, now }),
    createKey({ name: "Abe Approver", roles: ["approver"], passphrase: PASS, validDays: 365, now }),
  ]);
  store = addToTrustStore(JSON.stringify(addToTrustStore(null, JSON.stringify(author.trusted))), JSON.stringify(approver.trusted));

  folder = mkdtempSync(join(tmpdir(), "tdp-pack-"));
  mkdirSync(join(folder, "drawings"));
  mkdirSync(join(folder, "models"));
  writeFileSync(join(folder, "drawings", "W-100_A.pdf"), samplePdf("Washer", "W-100", "A"));
  writeFileSync(join(folder, "models", "W-100_A.stp"), writeStep("W-100", "Washer", [{ outline: [[0, 0], [20, 0], [20, 20], [0, 20]], z0: 0, height: 2 }]));
  writeFileSync(
    join(folder, SPEC_FILE),
    JSON.stringify({
      package: { title: "Washer TDP", partNumber: "W-100", revision: "A" },
      files: { "models/W-100_A.stp": { partNumber: "W-100", revision: "A" } },
      bom: [{ partNumber: "W-100", revision: "A", name: "Washer", quantity: 1, files: ["drawings/W-100_A.pdf", "models/W-100_A.stp"] }],
    }),
  );
}, 30_000);

const unlock = (k: NewKey) => unlockKey(JSON.stringify(k.keyFile), PASS);
const verdict = async (tdp: Uint8Array, ts = store) => (await verifyPackage(tdp, ts, defaultPolicy, later)).verdict;

describe("key files", () => {
  it("never contain the private key in the clear", () => {
    const json = JSON.stringify(author.keyFile);
    expect(json).not.toMatch(/PRIVATE|pkcs8/i);
    expect(author.keyFile.cipher.alg).toBe("AES-256-GCM");
  });

  it("reject a wrong passphrase", async () => {
    await expect(unlockKey(JSON.stringify(author.keyFile), "not the passphrase")).rejects.toThrow(/wrong passphrase/);
  });

  it("reject a key file whose public key was swapped", async () => {
    const spliced = { ...author.keyFile, publicKey: approver.keyFile.publicKey };
    await expect(unlockKey(JSON.stringify(spliced), PASS)).rejects.toThrow(/key id/);
  });

  it("put the holder's organization in the trust-store entry", async () => {
    const k = await createKey({ name: "Ollie Operator", roles: ["author"], passphrase: PASS, validDays: 30, organization: { name: "Print Shop", cage: "1ABC2" }, now });
    expect(k.trusted).toMatchObject({ organization: { name: "Print Shop", cage: "1ABC2" } });
    await expect(createKey({ name: "x", roles: ["author"], passphrase: PASS, validDays: 1, organization: { name: "Shop", cage: "bad" } })).rejects.toThrow(/CAGE/);
  });

  it("make workflow-only keys with no package-signing roles, but only with an organization", async () => {
    const k = await createKey({ name: "Wanda Workflow", roles: [], passphrase: PASS, validDays: 30, organization: { name: "Print Shop" }, now });
    expect(k.trusted).toMatchObject({ roles: [], organization: { name: "Print Shop" } });
    expect((await unlockKey(JSON.stringify(k.keyFile), PASS)).roles).toEqual([]);
    await expect(createKey({ name: "x", roles: [], passphrase: PASS, validDays: 1 })).rejects.toThrow(/needs an organization/);
  });

  it("refuse short passphrases", async () => {
    await expect(createKey({ name: "x", roles: ["author"], passphrase: "short", validDays: 1 })).rejects.toThrow(/at least/);
  });
});

describe("pack, sign, verify", () => {
  it("goes from a folder to a trusted package with two signers", async () => {
    const unsigned = await pack(folder, now);
    expect(await verdict(unsigned)).toBe("rejected");

    const one = await sign(unsigned, await unlock(author), "author", defaultPolicy, now);
    expect(await verdict(one)).toBe("rejected"); // approver still missing

    const two = await sign(one, await unlock(approver), "approver", defaultPolicy, now);
    expect(await verdict(two)).toBe("trusted");

    const manifest = JSON.parse(utf8.decode(unzipSync(two)["tdp-manifest.json"]!));
    expect(manifest.files.map((f: { path: string; role: string }) => [f.path, f.role])).toEqual([
      ["drawings/W-100_A.pdf", "drawing"],
      ["models/W-100_A.stp", "model"],
    ]);
  });

  it("won't sign a package whose contents don't match its manifest", async () => {
    const files: Record<string, Uint8Array> = unzipSync(await pack(folder, now));
    files["drawings/W-100_A.pdf"] = samplePdf("Washer", "W-100", "Z");
    await expect(sign(zipSync(files), await unlock(author), "author", defaultPolicy, now)).rejects.toThrow(/refusing to sign/);
  });

  it("won't add the same key and role twice", async () => {
    const once = await sign(await pack(folder, now), await unlock(author), "author", defaultPolicy, now);
    await expect(sign(once, await unlock(author), "author", defaultPolicy, now)).rejects.toThrow(/already signed/);
  });

  it("stops trusting a package after its signer's key is revoked", async () => {
    let tdp: Uint8Array = await pack(folder, now);
    tdp = await sign(tdp, await unlock(author), "author", defaultPolicy, now);
    tdp = await sign(tdp, await unlock(approver), "approver", defaultPolicy, now);
    const revoked = revokeInTrustStore(JSON.stringify(store), approver.trusted.keyId);
    expect(await verdict(tdp, revoked)).toBe("rejected");
  });

  it("rejects a spec that describes files not in the folder", async () => {
    const bad = mkdtempSync(join(tmpdir(), "tdp-pack-"));
    writeFileSync(join(bad, SPEC_FILE), JSON.stringify({ package: { title: "x", partNumber: "X-1", revision: "A" }, files: { "ghost.pdf": {} } }));
    writeFileSync(join(bad, "real.txt"), "hello");
    await expect(pack(bad)).rejects.toThrow(/ghost.pdf/);
  });
});
