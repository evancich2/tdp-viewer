import { beforeAll, describe, expect, it } from "vitest";
import { generateKeyPair, loadAnchors, loadTrustStoreFile, signTrustStore, type Anchors, type TrustStore } from "../src/core";
import { fromBase64, toBase64, utf8 } from "../src/core/bytes";

const now = new Date("2026-06-01T00:00:00Z");
let root: Awaited<ReturnType<typeof generateKeyPair>> & { name: string };
let other: Awaited<ReturnType<typeof generateKeyPair>> & { name: string };
let anchors: Anchors;
let store: TrustStore;

beforeAll(async () => {
  root = { ...(await generateKeyPair()), name: "Acme Root" };
  other = { ...(await generateKeyPair()), name: "Mallory Root" };
  anchors = await loadAnchors(JSON.stringify({ schema: "tdp-anchors/0.1", roots: [{ keyId: root.keyId, name: root.name, publicKey: root.publicKey }] }));
  const signer = await generateKeyPair();
  store = {
    schema: "tdp-truststore/0.1",
    keys: [{ keyId: signer.keyId, name: "Ann", publicKey: signer.publicKey, roles: ["author"], notBefore: now.toISOString(), notAfter: "2027-06-01T00:00:00Z", revoked: false }],
  };
});

const sign = async (by = root, serial = 1, validDays = 365) => JSON.stringify(await signTrustStore(store, by, { serial, validDays, now }));

describe("signed trust stores", () => {
  it("load when signed by a pinned root", async () => {
    const loaded = await loadTrustStoreFile(await sign(), { anchors, now });
    expect(loaded.signedBy?.name).toBe("Acme Root");
    expect(loaded.store.serial).toBe(1);
    expect(loaded.store.keys).toHaveLength(1);
  });

  it("are refused when signed by a root that isn't pinned", async () => {
    await expect(loadTrustStoreFile(await sign(other), { anchors, now })).rejects.toThrow(/no valid signature from a pinned root/);
  });

  it("are refused when the signed contents were edited", async () => {
    const signed = JSON.parse(await sign());
    const payload = JSON.parse(utf8.decode(fromBase64(signed.payload)));
    payload.keys[0].roles = ["author", "approver"];
    signed.payload = toBase64(utf8.encode(JSON.stringify(payload)));
    await expect(loadTrustStoreFile(JSON.stringify(signed), { anchors, now })).rejects.toThrow(/no valid signature/);
  });

  it("are refused when older than a serial already seen (rollback)", async () => {
    const seenSerials = { [root.keyId]: 5 };
    await expect(loadTrustStoreFile(await sign(root, 4), { anchors, now, seenSerials })).rejects.toThrow(/rollback/);
    await expect(loadTrustStoreFile(await sign(root, 5), { anchors, now, seenSerials })).resolves.toBeTruthy();
  });

  it("are refused after they expire", async () => {
    const later = new Date(now.getTime() + 31 * 86_400_000);
    await expect(loadTrustStoreFile(await sign(root, 1, 30), { anchors, now: later })).rejects.toThrow(/expired/);
  });

  it("need anchors to be checked at all", async () => {
    await expect(loadTrustStoreFile(await sign(), { now })).rejects.toThrow(/root key/);
  });
});

describe("plain trust stores", () => {
  it("load when no root is pinned", async () => {
    const loaded = await loadTrustStoreFile(JSON.stringify(store), { now });
    expect(loaded.signedBy).toBeUndefined();
  });

  it("are refused once a root is pinned, so nobody can downgrade you to unsigned", async () => {
    await expect(loadTrustStoreFile(JSON.stringify(store), { anchors, now })).rejects.toThrow(/isn't signed/);
  });
});

describe("anchors", () => {
  it("reject a root whose key id doesn't match its key", async () => {
    const bad = { schema: "tdp-anchors/0.1", roots: [{ keyId: root.keyId, name: "x", publicKey: other.publicKey }] };
    await expect(loadAnchors(JSON.stringify(bad))).rejects.toThrow(/key id mismatch/);
  });
});
