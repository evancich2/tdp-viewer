import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { buildPackage, generateKeyPair, type KeyPair, type TrustStore } from "../src/core";
import { utf8 } from "../src/core/bytes";
import { receiveLabPackage, recipientFingerprint, sealLabPackage, signLabEnvelope, type LabEnvelope } from "../tools/lab-envelope";

const now = new Date("2026-11-19T18:00:00Z");
let author: KeyPair, approver: KeyPair, outsider: KeyPair, store: TrustStore, payload: Uint8Array, envelope: LabEnvelope;
const rsa = generateKeyPairSync("rsa", { modulusLength: 3072 });
const context = () => ({ recipientPrivate: rsa.privateKey, senderPublic: author.publicKey, store, seen: new Set<string>(), now });
beforeAll(async () => {
  [author, approver, outsider] = await Promise.all([generateKeyPair(), generateKeyPair(), generateKeyPair()]);
  const key = (k: KeyPair, role: "author" | "approver") => ({ keyId: k.keyId, publicKey: k.publicKey, name: role, roles: [role], notBefore: "2026-11-18T00:00:00Z", notAfter: "2026-11-21T00:00:00Z", revoked: false });
  store = { schema: "tdp-truststore/0.1", keys: [key(author, "author"), key(approver, "approver")] };
  payload = await buildPackage({ id: "9b6bc861-d8be-4e67-8314-383ccf5e0e34", title: "Laboratory only", partNumber: "LAB-1", revision: "A", created: "2026-11-19T00:00:00Z" }, [{ path: "evidence.txt", bytes: utf8.encode("laboratory payload, no restricted data"), mediaType: "text/plain", role: "spec" }], [], [{ ...author, role: "author" }, { ...approver, role: "approver" }], now);
  envelope = await sealLabPackage(payload, rsa.publicKey, author, now);
});
describe("experimental signed encrypted handoff", () => {
  it("recovers identical bytes and applies the recipient's own package policy", async () => {
    const result = await receiveLabPackage(envelope, context());
    expect(Buffer.compare(Buffer.from(result.payload), Buffer.from(payload))).toBe(0);expect(result.session.trusted).toBe(true);
    expect(utf8.decode((await result.session.openFile("evidence.txt", "test")).bytes)).toContain("laboratory payload");
  });
  it("pins the recipient public key and rejects a different private key", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 3072 });
    await expect(receiveLabPackage(envelope, { ...context(), recipientPrivate: other.privateKey })).rejects.toThrow(/wrong recipient/);
  });
  it("rejects an untrusted envelope signer", async () => {
    await expect(receiveLabPackage(envelope, { ...context(), senderPublic: outsider.publicKey })).rejects.toThrow(/signature/);
  });
  it("rejects changed ciphertext before releasing any payload", async () => {
    const ciphertext = `${envelope.ciphertext[0] === "A" ? "B" : "A"}${envelope.ciphertext.slice(1)}`;
    await expect(receiveLabPackage({ ...envelope, ciphertext }, context())).rejects.toThrow(/signature/);
  });
  it("rejects changed signed recipient metadata", async () => {
    await expect(receiveLabPackage({ ...envelope, header: { ...envelope.header, recipient: "other" } }, context())).rejects.toThrow();
  });
  it("checks GCM authentication even when the bad tag has a valid sender signature", async () => {
    const tag = Buffer.alloc(16, 0).toString("base64");
    const bad = await signLabEnvelope({ ...envelope, tag }, author);
    await expect(receiveLabPackage(bad, context())).rejects.toThrow();
  });
  it("binds the signed header as GCM associated data", async () => {
    const header = { ...envelope.header, payloadSha256: "0".repeat(64) };
    const bad = await signLabEnvelope({ ...envelope, header }, author);
    await expect(receiveLabPackage(bad, context())).rejects.toThrow();
  });
  it("rejects replay in the recipient state supplied by the caller", async () => {
    const ctx = context();await receiveLabPackage(envelope, ctx);
    await expect(receiveLabPackage(envelope, ctx)).rejects.toThrow(/replayed/);
  });
  it("rejects expiry before cryptographic admission", async () => {
    await expect(receiveLabPackage(envelope, { ...context(), now: new Date(now.getTime() + 600_000) })).rejects.toThrow(/expired/);
  });
  it("applies revocation from the recipient trust store", async () => {
    const revoked = { ...store, keys: store.keys.map((k) => k.keyId === author.keyId ? { ...k, revoked: true } : k) };
    await expect(receiveLabPackage(envelope, { ...context(), store: revoked })).rejects.toThrow(/package verification/);
  });
  it("cannot replace recipient trust through an envelope field", async () => {
    await expect(receiveLabPackage({ ...envelope, trustStore: store }, context())).rejects.toThrow();
  });
  it("rejects undersized and malformed GCM fields", async () => {
    const bad = await signLabEnvelope({ ...envelope, iv: "AAAA" }, author);
    await expect(receiveLabPackage(bad, context())).rejects.toThrow(/cipher fields/);
    await expect(receiveLabPackage({ ...envelope, ciphertext: "not base64" }, context())).rejects.toThrow();
  });
  it("uses fresh encryption key, IV and transfer identity for each sealing", async () => {
    const again = await sealLabPackage(payload, rsa.publicKey, author, now);
    expect(again.iv).not.toBe(envelope.iv);expect(again.ciphertext).not.toBe(envelope.ciphertext);expect(again.header.transferId).not.toBe(envelope.header.transferId);
  });
  it("rejects empty and oversized laboratory payloads", async () => {
    await expect(sealLabPackage(new Uint8Array(), rsa.publicKey, author, now)).rejects.toThrow(/size/);
    await expect(sealLabPackage(new Uint8Array(8 * 1024 * 1024 + 1), rsa.publicKey, author, now)).rejects.toThrow(/size/);
  });
  it("rejects an RSA profile other than the explicitly bounded laboratory profile", () => {
    const small = generateKeyPairSync("rsa", { modulusLength: 2048 });expect(() => recipientFingerprint(small.publicKey)).toThrow(/3072/);
  });
  it("does not bypass package verification for encrypted garbage", async () => {
    const garbage = await sealLabPackage(utf8.encode("not a package"), rsa.publicKey, author, now);
    await expect(receiveLabPackage(garbage, context())).rejects.toThrow();
  });
});
