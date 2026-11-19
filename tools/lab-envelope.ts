/** Experimental evidence harness only. Not a production protocol or an accredited crypto boundary. */
import { constants, createCipheriv, createDecipheriv, createHash, createPublicKey, privateDecrypt, publicEncrypt, randomBytes, randomUUID, type KeyObject } from "node:crypto";
import { z } from "zod";
import { PackageSession, defaultPolicy, type KeyPair, type TrustStore } from "../src/core";
import { utf8 } from "../src/core/bytes";
import { signEd25519, verifyEd25519 } from "../src/core/signing";

const MAX_BYTES = 8 * 1024 * 1024;
const b64 = (max: number) => z.string().min(4).max(max).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const headerSchema = z.object({
  schema: z.literal("tdp-experimental-handoff/0.1"),
  sender: z.literal("lab-sender-a"), recipient: z.literal("lab-recipient-b"),
  transferId: z.string().uuid(), expires: z.string().datetime(),
  recipientKeySha256: z.string().regex(/^[a-f0-9]{64}$/), payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const envelopeSchema = z.object({
  header: headerSchema, wrappedKey: b64(1024), iv: b64(24), tag: b64(32), ciphertext: b64(Math.ceil(MAX_BYTES / 3) * 4), signature: b64(100),
}).strict();
export type LabEnvelope = z.infer<typeof envelopeSchema>;
type Unsigned = Omit<LabEnvelope, "signature">;
export const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function recipientFingerprint(key: KeyObject): string {
  const pub = key.type === "public" ? key : createPublicKey(key);
  if (pub.asymmetricKeyType !== "rsa" || pub.asymmetricKeyDetails?.modulusLength !== 3072) throw new Error("lab recipient requires RSA 3072 bits");
  return digest(pub.export({ type: "spki", format: "der" }));
}
function unsigned(e: Unsigned): Unsigned {
  return { header: headerSchema.parse(e.header), wrappedKey: e.wrappedKey, iv: e.iv, tag: e.tag, ciphertext: e.ciphertext };
}
const signingBytes = (e: Unsigned) => utf8.encode(`tdp-experimental-envelope/0.1\n${digest(utf8.encode(JSON.stringify(unsigned(e))))}`);
/** Exposed to construct explicitly signed invalid test vectors as well as the valid lab envelope. */
export async function signLabEnvelope(e: Unsigned, signer: KeyPair): Promise<LabEnvelope> {
  return envelopeSchema.parse({ ...unsigned(e), signature: await signEd25519(signer.privateKey, signingBytes(e)) });
}
export async function sealLabPackage(payload: Uint8Array, recipientPublic: KeyObject, signer: KeyPair, now = new Date()): Promise<LabEnvelope> {
  if (!payload.length || payload.length > MAX_BYTES) throw new Error("lab payload size outside bound");
  const header = headerSchema.parse({ schema: "tdp-experimental-handoff/0.1", sender: "lab-sender-a", recipient: "lab-recipient-b", transferId: randomUUID(), expires: new Date(now.getTime() + 600_000).toISOString(), recipientKeySha256: recipientFingerprint(recipientPublic), payloadSha256: digest(payload) });
  const key = randomBytes(32), iv = randomBytes(12);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);cipher.setAAD(Buffer.from(JSON.stringify(header)));
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    const wrappedKey = publicEncrypt({ key: recipientPublic, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
    return await signLabEnvelope({ header, wrappedKey: wrappedKey.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }, signer);
  } finally { key.fill(0); }
}
export async function receiveLabPackage(raw: unknown, ctx: { recipientPrivate: KeyObject; senderPublic: string; store: TrustStore; seen: Set<string>; now?: Date }): Promise<{ payload: Uint8Array; session: PackageSession; transferId: string }> {
  const e = envelopeSchema.parse(raw);const now = ctx.now ?? new Date();
  if (ctx.seen.has(e.header.transferId)) throw new Error("replayed transfer");
  if (Date.parse(e.header.expires) <= now.getTime()) throw new Error("expired transfer");
  if (e.header.recipientKeySha256 !== recipientFingerprint(ctx.recipientPrivate)) throw new Error("wrong recipient key");
  if (!(await verifyEd25519(ctx.senderPublic, e.signature, signingBytes(e)))) throw new Error("untrusted envelope signature");
  const iv = Buffer.from(e.iv, "base64"), tag = Buffer.from(e.tag, "base64"), wrapped = Buffer.from(e.wrappedKey, "base64"), encrypted = Buffer.from(e.ciphertext, "base64");
  if (iv.length !== 12 || tag.length !== 16 || wrapped.length !== 384 || encrypted.length > MAX_BYTES) throw new Error("invalid bounded cipher fields");
  const key = privateDecrypt({ key: ctx.recipientPrivate, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, wrapped);
  try {
    if (key.length !== 32) throw new Error("invalid unwrapped key");
    const cipher = createDecipheriv("aes-256-gcm", key, iv);cipher.setAAD(Buffer.from(JSON.stringify(e.header)));cipher.setAuthTag(tag);
    const payload = Buffer.concat([cipher.update(encrypted), cipher.final()]);
    if (digest(payload) !== e.header.payloadSha256) throw new Error("payload digest mismatch");
    const session = await PackageSession.open("lab-recipient.tdp", payload, ctx.store, defaultPolicy, undefined, now);
    if (!session.trusted) throw new Error("recipient package verification rejected");
    ctx.seen.add(e.header.transferId);
    return { payload, session, transferId: e.header.transferId };
  } finally { key.fill(0); }
}
