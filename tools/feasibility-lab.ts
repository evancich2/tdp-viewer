/** Executes public-model and two-process handoff evidence. Never use the generated lab keys in service. */
import { generateKeyPairSync, createPrivateKey } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildPackage, defaultPolicy, generateKeyPair, PackageSession, type TrustStore, type KeyPair } from "../src/core";
import { signTrustStore, loadTrustStoreFile, type Anchors } from "../src/core/truststore";
import { meshStep, type Occt } from "../src/mesh/occt";
import { meshStats, weld } from "../src/core/mesh";
import { utf8 } from "../src/core/bytes";
import { digest, receiveLabPackage, sealLabPackage } from "./lab-envelope";

const json = (x: unknown) => JSON.stringify(x, null, 2);
const write = (p: string, x: unknown) => writeFileSync(p, json(x));
interface ReceiverContext { privatePem: string; senderPublic: string; signedStore: string; anchors: Anchors; }
if (process.argv[2] === "receive") {
  const [contextPath, incomingPath, outputPath] = process.argv.slice(3);
  if (!contextPath || !incomingPath || !outputPath) throw new Error("receiver paths required");
  const ctx = JSON.parse(readFileSync(contextPath, "utf8")) as ReceiverContext;
  const trusted = await loadTrustStoreFile(ctx.signedStore, { anchors: ctx.anchors });
  const received = await receiveLabPackage(JSON.parse(readFileSync(incomingPath, "utf8")), { recipientPrivate: createPrivateKey(ctx.privatePem), senderPublic: ctx.senderPublic, store: trusted.store, seen: new Set() });
  const model = await received.session.openFile("models/nist.stp", "laboratory recipient model admission");
  writeFileSync(outputPath, received.payload);
  write(`${outputPath}.receipt.json`, { accepted: true, transferId: received.transferId, packageSha256: digest(received.payload), modelSha256: digest(model.bytes), signedTrustStoreRoot: trusted.signedBy?.keyId, audit: await received.session.audit.list() });
} else {
  const out = resolve(process.argv[2] ?? ".lab-evidence");mkdirSync(out, { recursive: true });mkdirSync(join(out, ".private"), { recursive: true });
  const now = new Date(), before = new Date(now.getTime() - 60_000).toISOString(), after = new Date(now.getTime() + 86_400_000).toISOString();
  const [author, approver, rootA, rootB, receiverSigner] = await Promise.all(Array.from({ length: 5 }, () => generateKeyPair()));
  const key = (k: KeyPair, roles: ("author" | "approver" | "release")[], name: string) => ({ keyId: k.keyId, publicKey: k.publicKey, name, roles, notBefore: before, notAfter: after, revoked: false });
  const storeA: TrustStore = { schema: "tdp-truststore/0.1", keys: [key(author!, ["author"], "Lab sender A author"), key(approver!, ["approver"], "Lab sender A approver")] };
  const storeB: TrustStore = { schema: "tdp-truststore/0.1", keys: [...storeA.keys, key(receiverSigner!, ["release"], "Lab recipient B local release")] };
  const anchors = (root: KeyPair, name: string): Anchors => ({ schema: "tdp-anchors/0.1", roots: [{ keyId: root.keyId, publicKey: root.publicKey, name }] });
  const signedA = await signTrustStore(storeA, { ...rootA!, name: "Lab sender A root" }, { serial: 1, validDays: 1, now });
  const signedB = await signTrustStore(storeB, { ...rootB!, name: "Lab recipient B root" }, { serial: 1, validDays: 1, now });
  const loadedA = await loadTrustStoreFile(json(signedA), { anchors: anchors(rootA!, "Lab sender A root"), now });
  const loadedB = await loadTrustStoreFile(json(signedB), { anchors: anchors(rootB!, "Lab recipient B root"), now });
  const occt = (await createRequire(import.meta.url)("occt-import-js")()) as Occt;
  const geometries = [];
  for (const name of ["nist_ctc_01_asme1_ap242-e1.stp", "nist_stc_06_asme1_ap242-e3.stp"]) {
    const bytes = readFileSync(join("samples/public-nist", name));const start = performance.now();const raw = meshStep(occt, bytes);const meshes = raw.map((m) => meshStats(weld(m)));
    geometries.push({ file: name, bytes: bytes.length, sha256: digest(bytes), meshes: meshes.length, rawTriangles: raw.reduce((s,m)=>s+m.indices.length/3,0), triangles: meshes.reduce((s, m) => s + m.triangles, 0), details: meshes, elapsedMs: performance.now() - start, limit: "Geometry tessellation only; semantic PMI not interpreted; weld removes degenerate triangles" });
  }
  const model = readFileSync("samples/public-nist/nist_stc_06_asme1_ap242-e3.stp");
  const packageBytes = await buildPackage({ id: "0b6bc861-d8be-4e67-8314-383ccf5e0e34", title: "Public NIST STC-06 laboratory evidence", partNumber: "NIST-STC-06", revision: "public-ap242-e3", created: before, expires: after }, [{ path: "models/nist.stp", bytes: model, mediaType: "model/step", role: "model" }], [], [{ ...author!, role: "author" }, { ...approver!, role: "approver" }], now);
  const sender = await PackageSession.open("nist-sender.tdp", packageBytes, loadedA.store, defaultPolicy, undefined, now);
  if (!sender.trusted) throw new Error("sender package rejected");
  const rsa = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const envelope = await sealLabPackage(packageBytes, rsa.publicKey, author!, now);
  const incoming = join(out, "encrypted-handoff.json"), receivedPath = join(out, "nist-received.tdp"), privatePath = join(out, ".private/recipient.key.json");
  write(incoming, envelope);
  writeFileSync(privatePath, json({ privatePem: rsa.privateKey.export({ type: "pkcs8", format: "pem" }), senderPublic: author!.publicKey, signedStore: json(signedB), anchors: anchors(rootB!, "Lab recipient B root") }), { mode: 0o600 });
  const child = spawnSync(process.execPath, ["--import", "tsx", "tools/feasibility-lab.ts", "receive", privatePath, incoming, receivedPath], { encoding: "utf8", timeout: 60_000 });
  if (child.status !== 0) throw new Error(`recipient process failed: ${child.stderr}`);
  const receivedBytes = readFileSync(receivedPath);if (digest(receivedBytes) !== digest(packageBytes)) throw new Error("handoff bytes differ");
  const ctx = { recipientPrivate: rsa.privateKey, senderPublic: author!.publicKey, store: loadedB.store, seen: new Set<string>(), now };
  const accepted = await receiveLabPackage(envelope, ctx);
  const negatives: { case: string; rejected: boolean; reason: string }[] = [];
  const rejection = async (name: string, fn: () => Promise<unknown>) => { try { await fn(); } catch (error) { negatives.push({ case: name, rejected: true, reason: String(error).slice(0, 250) });return; }throw new Error(`negative accepted: ${name}`); };
  await rejection("replay", () => receiveLabPackage(envelope, ctx));
  await rejection("expired grant", () => receiveLabPackage(envelope, { ...ctx, seen: new Set(), now: new Date(now.getTime() + 660_000) }));
  await rejection("altered ciphertext", () => receiveLabPackage({ ...envelope, ciphertext: `${envelope.ciphertext[0] === "A" ? "B" : "A"}${envelope.ciphertext.slice(1)}` }, { ...ctx, seen: new Set() }));
  await rejection("altered recipient metadata", () => receiveLabPackage({ ...envelope, header: { ...envelope.header, recipient: "attacker" } }, { ...ctx, seen: new Set() }));
  const wrongRsa = generateKeyPairSync("rsa", { modulusLength: 3072 });
  await rejection("wrong recipient private key", () => receiveLabPackage(envelope, { ...ctx, seen: new Set(), recipientPrivate: wrongRsa.privateKey }));
  await rejection("wrong pinned sender", () => receiveLabPackage(envelope, { ...ctx, seen: new Set(), senderPublic: receiverSigner!.publicKey }));
  await rejection("receiver revoked author", () => receiveLabPackage(envelope, { ...ctx, seen: new Set(), store: { ...loadedB.store, keys: loadedB.store.keys.map((k) => k.keyId === author!.keyId ? { ...k, revoked: true } : k) } }));
  write(join(out, "recipient-anchors.json"), anchors(rootB!, "Lab recipient B root"));write(join(out, "recipient-trust-store.signed.json"), signedB);
  write(join(out, "results.json"), { at: now.toISOString(), baseSource: "200b6ccf1ceaf1a2f1047788d8925a643a2bad83", mode: "NEW experimental laboratory transport harness plus existing verifier, two local Node processes", geometries, exchange: { accepted: true, bytes: receivedBytes.length, packageSha256: digest(packageBytes), recoveredSha256: digest(receivedBytes), recoveredModelSha256: digest((await accepted.session.openFile("models/nist.stp", "evidence hash")).bytes), senderStoreSha256: digest(utf8.encode(json(signedA))), receiverStoreSha256: digest(utf8.encode(json(signedB))), senderRoot: rootA!.keyId, receiverRoot: rootB!.keyId, algorithms: "Ed25519 envelope/package signatures; RSA-3072 OAEP-SHA256 key wrap; AES-256-GCM payload", negatives }, limits: ["Simulated sender/recipient organizations on one host, not a live EEL/ThinkHARI exchange", "Not FIPS validation, production authorization, persistent replay-ledger deployment or operational key custody", "Public NIST geometry; no semantic-PMI interpretation claim"] });
  console.log(json({ geometries: geometries.map((g) => ({ file: g.file, triangles: g.triangles, meshes: g.meshes })), twoProcessHandoff: "PASS", negativeCases: negatives.length, output: out }));
}
