// RFC 3161 time-stamping of tree heads (CLI only: requesting a timestamp is a network call; the
// browser app never makes one). A timestamp from a TSA you trust proves a tree head, and so every
// record under it, existed no later than the TSA's genTime. That is the independent bound on time
// that signatures alone don't give.
//
// Verification is offline and fail-closed: response status granted; TSTInfo message imprint equals
// the head digest (SHA-256) and the request nonce; signed attributes carry id-ct-TSTInfo and the
// eContent digest; the signature over the signed attributes verifies with the signer certificate;
// that certificate has the critical timeStamping extended key usage, was valid at genTime, and is
// (or is issued by) a TSA certificate you pinned. RSA PKCS#1 v1.5 and ECDSA with SHA-256/384/512.
import { X509Certificate, createHash, createPublicKey, randomBytes, verify as cryptoVerify } from "node:crypto";
import { z } from "zod";

// ---- Minimal DER ----

interface Tlv { tag: number; start: number; header: number; len: number; end: number; bytes: Buffer }

function readTlv(b: Buffer, o: number): Tlv {
  if (o + 2 > b.length) throw new Error("DER: truncated");
  const tag = b[o]!;
  if ((tag & 0x1f) === 0x1f) throw new Error("DER: high tag numbers not supported");
  let len = b[o + 1]!;
  let header = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error("DER: bad length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[o + 2 + i]!;
    header += n;
  }
  const end = o + header + len;
  if (end > b.length) throw new Error("DER: truncated");
  return { tag, start: o, header, len, end, bytes: b.subarray(o, end) };
}
const children = (t: Tlv, b: Buffer): Tlv[] => {
  const out: Tlv[] = [];
  for (let o = t.start + t.header; o < t.end; ) {
    const c = readTlv(b, o);
    if (c.end > t.end) throw new Error("DER: element overruns its parent");
    out.push(c);
    o = c.end;
  }
  return out;
};
const body = (t: Tlv, b: Buffer) => b.subarray(t.start + t.header, t.end);
const expect = (t: Tlv | undefined, tag: number, what: string): Tlv => { if (!t || t.tag !== tag) throw new Error(`DER: expected ${what}`); return t; };

function oid(t: Tlv, b: Buffer): string {
  if (t.tag !== 0x06) throw new Error("DER: expected OBJECT IDENTIFIER");
  const v = body(t, b);
  const parts = [Math.floor(v[0]! / 40), v[0]! % 40];
  let n = 0;
  for (const x of v.subarray(1)) { n = n * 128 + (x & 0x7f); if (!(x & 0x80)) { parts.push(n); n = 0; } }
  return parts.join(".");
}

const enc = (tag: number, content: Buffer) => {
  const l = content.length;
  const len = l < 128 ? Buffer.from([l]) : l < 256 ? Buffer.from([0x81, l]) : Buffer.from([0x82, l >> 8, l & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, content]);
};
const seq = (...xs: Buffer[]) => enc(0x30, Buffer.concat(xs));
const intBytes = (v: Buffer) => enc(0x02, v[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v);

const OID = {
  sha256: "2.16.840.1.101.3.4.2.1", sha384: "2.16.840.1.101.3.4.2.2", sha512: "2.16.840.1.101.3.4.2.3",
  signedData: "1.2.840.113549.1.7.2", tstInfo: "1.2.840.113549.1.9.16.1.4",
  contentType: "1.2.840.113549.1.9.3", messageDigest: "1.2.840.113549.1.9.4",
  rsa: "1.2.840.113549.1.1.1", sha256Rsa: "1.2.840.113549.1.1.11", sha384Rsa: "1.2.840.113549.1.1.12", sha512Rsa: "1.2.840.113549.1.1.13",
  ecdsaSha256: "1.2.840.10045.4.3.2", ecdsaSha384: "1.2.840.10045.4.3.3", ecdsaSha512: "1.2.840.10045.4.3.4",
  timeStamping: "1.3.6.1.5.5.7.3.8",
};
const HASH_OF: Record<string, string> = { [OID.sha256]: "sha256", [OID.sha384]: "sha384", [OID.sha512]: "sha512" };
const SIG_HASH: Record<string, string> = { [OID.sha256Rsa]: "sha256", [OID.sha384Rsa]: "sha384", [OID.sha512Rsa]: "sha512", [OID.ecdsaSha256]: "sha256", [OID.ecdsaSha384]: "sha384", [OID.ecdsaSha512]: "sha512" };

// SHA-256 AlgorithmIdentifier, DER, with NULL parameters.
const SHA256_ALG = Buffer.from("300d06096086480165030402010500", "hex");

/** A TimeStampReq (RFC 3161 §2.4.1) for a SHA-256 digest, asking for the TSA certificate. */
export function timestampRequest(digestHex: string, nonce: Buffer = randomBytes(8)): { der: Buffer; nonce: string } {
  if (!/^[0-9a-f]{64}$/.test(digestHex)) throw new Error("digest must be SHA-256 hex");
  const der = seq(enc(0x02, Buffer.from([1])), seq(SHA256_ALG, enc(0x04, Buffer.from(digestHex, "hex"))), intBytes(nonce), enc(0x01, Buffer.from([0xff])));
  return { der, nonce: BigInt(`0x${nonce.toString("hex")}`).toString(16) };
}

export interface TimestampResult {
  genTime: string;
  tsa: string;
  serial: string;
  policy: string;
}

/** Parses GeneralizedTime YYYYMMDDHHMMSS[.fff]Z. */
function genTime(s: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/.exec(s);
  if (!m) throw new Error(`unsupported genTime ${s}`);
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ?? ""}Z`).toISOString();
}

/**
 * Verifies a TimeStampResp for `digestHex`. `trusted` are the TSA certificates you pin (PEM or DER):
 * the signer certificate must be one of them or be issued by one of them.
 */
export function verifyTimestamp(resp: Buffer, digestHex: string, trusted: X509Certificate[], expectNonce?: string): TimestampResult {
  const b = resp;
  const top = expect(readTlv(b, 0), 0x30, "TimeStampResp");
  if (top.end !== b.length) throw new Error("DER: trailing or missing bytes");
  const [statusInfo, token] = children(top, b);
  const status = children(expect(statusInfo, 0x30, "PKIStatusInfo"), b)[0]!;
  const st = body(expect(status, 0x02, "status"), b).readUIntBE(0, body(status, b).length);
  if (st !== 0 && st !== 1) throw new Error(`TSA refused the request (status ${st})`);
  const [ctype, explicit] = children(expect(token, 0x30, "timeStampToken"), b);
  if (oid(expect(ctype, 0x06, "contentType"), b) !== OID.signedData) throw new Error("token is not SignedData");
  const sd = children(expect(explicit, 0xa0, "[0]"), b)[0]!;
  const sdParts = children(expect(sd, 0x30, "SignedData"), b);
  if (body(expect(sdParts[0], 0x02, "version"), b).toString("hex") !== "03") throw new Error("SignedData version must be 3");
  const digestAlgs = children(expect(sdParts[1], 0x31, "digestAlgorithms"), b).map((a) => oid(children(expect(a, 0x30, "AlgorithmIdentifier"), b)[0]!, b));
  const encap = children(expect(sdParts[2], 0x30, "encapContentInfo"), b);
  if (oid(expect(encap[0], 0x06, "eContentType"), b) !== OID.tstInfo) throw new Error("token does not hold TSTInfo");
  const eContent = body(expect(children(expect(encap[1], 0xa0, "[0]"), b)[0], 0x04, "eContent"), b);

  // TSTInfo
  const tb = Buffer.from(eContent);
  const tst = children(expect(readTlv(tb, 0), 0x30, "TSTInfo"), tb);
  const policy = oid(expect(tst[1], 0x06, "policy"), tb);
  const imprint = children(expect(tst[2], 0x30, "messageImprint"), tb);
  const impAlg = oid(children(imprint[0]!, tb)[0]!, tb);
  const impHash = body(expect(imprint[1], 0x04, "hashedMessage"), tb).toString("hex");
  if (impAlg !== OID.sha256 || impHash !== digestHex) throw new Error("timestamp is for a different digest");
  const serial = body(expect(tst[3], 0x02, "serialNumber"), tb).toString("hex");
  const time = genTime(body(expect(tst[4], 0x18, "genTime"), tb).toString("ascii"));
  const nonceTlv = tst.slice(5).find((t) => t.tag === 0x02);
  if (expectNonce !== undefined) {
    if (!nonceTlv) throw new Error("timestamp has no nonce");
    if (BigInt(`0x${body(nonceTlv, tb).toString("hex")}`).toString(16) !== expectNonce) throw new Error("timestamp nonce does not match the request");
  }

  // Certificates and the signer
  let rest = sdParts.slice(3);
  const certs: X509Certificate[] = [];
  if (rest[0]?.tag === 0xa0) { for (const c of children(rest[0], b)) certs.push(new X509Certificate(c.bytes)); rest = rest.slice(1); }
  if (rest[0]?.tag === 0xa1) rest = rest.slice(1);
  const signerInfos = children(expect(rest[0], 0x31, "signerInfos"), b);
  if (signerInfos.length !== 1) throw new Error("expected exactly one signer");
  const si = children(expect(signerInfos[0], 0x30, "SignerInfo"), b);
  const siVersion = body(expect(si[0], 0x02, "version"), b).toString("hex");
  const digestOid = oid(children(expect(si[2], 0x30, "digestAlgorithm"), b)[0]!, b);
  const digestAlg = HASH_OF[digestOid];
  if (!digestAlg) throw new Error("unsupported digest algorithm");
  if (!digestAlgs.includes(digestOid)) throw new Error("signer's digest algorithm is not listed in SignedData");
  const signedAttrs = expect(si[3], 0xa0, "signedAttrs");
  const sigAlgOid = oid(children(expect(si[4], 0x30, "signatureAlgorithm"), b)[0]!, b);
  const signature = body(expect(si[5], 0x04, "signature"), b);
  let ct: string | undefined;
  let md: string | undefined;
  for (const attr of children(signedAttrs, b)) {
    const [t, values] = children(attr, b);
    const type = oid(t!, b);
    const v = children(values!, b)[0]!;
    if (type === OID.contentType) ct = oid(v, b);
    if (type === OID.messageDigest) md = body(v, b).toString("hex");
  }
  if (ct !== OID.tstInfo) throw new Error("signed content type is not TSTInfo");
  if (md !== createHash(digestAlg).update(eContent).digest("hex")) throw new Error("signed message digest does not match the TSTInfo");
  // The signature covers the signed attributes re-encoded as a SET (tag 0x31).
  const toVerify = Buffer.concat([Buffer.from([0x31]), signedAttrs.bytes.subarray(1)]);
  const hash = SIG_HASH[sigAlgOid] ?? (sigAlgOid === OID.rsa ? digestAlg : undefined);
  if (!hash) throw new Error(`unsupported signature algorithm ${sigAlgOid}`);
  const signer = certs.find((c) => { try { return cryptoVerify(hash, toVerify, createPublicKey(c.publicKey.export({ type: "spki", format: "pem" })), signature); } catch { return false; } });
  if (!signer) throw new Error("timestamp signature does not verify with any certificate in the token");
  // The signer identifier must name that certificate: issuer and serial (v1) or subject key identifier (v3).
  const sid = si[1]!;
  if (siVersion === "01" && sid.tag === 0x30) {
    const [issuer, serialNo] = children(sid, b);
    const tbs = children(children(readTlv(signer.raw, 0), signer.raw)[0]!, signer.raw);
    const certIssuer = tbs[tbs[0]!.tag === 0xa0 ? 3 : 2]!;
    if (!issuer!.bytes.equals(certIssuer.bytes) || body(expect(serialNo, 0x02, "serial"), b).toString("hex").replace(/^00/, "").toUpperCase() !== signer.serialNumber.replace(/^00/, "").toUpperCase())
      throw new Error("signer identifier does not match the certificate that signed");
  } else if (siVersion === "03" && sid.tag === 0x80) {
    throw new Error("subject-key-identifier signer ids are not supported yet");
  } else throw new Error("SignerInfo version and signer identifier don't agree");
  if (!signer.keyUsage?.includes(OID.timeStamping)) throw new Error("signer certificate is not for time-stamping (extended key usage)");
  const t = Date.parse(time);
  if (t < Date.parse(signer.validFrom) || t > Date.parse(signer.validTo)) throw new Error("signer certificate was not valid at genTime");
  const anchored = trusted.some((a) => a.fingerprint256 === signer.fingerprint256 || (signer.checkIssued(a) && signer.verify(a.publicKey)));
  if (!anchored) throw new Error(`timestamp signed by ${signer.subject.replace(/\n/g, ", ")}, which is not a pinned TSA certificate or issued by one`);
  return { genTime: time, tsa: signer.subject.replace(/\n/g, ", "), serial, policy };
}

/** Byte ranges of the parts a verifier relies on (for tests): TSTInfo, signed attributes, signature, signer certificate. */
export function criticalRanges(resp: Buffer, signerCertDer: Buffer): [number, number][] {
  const b = resp;
  const token = children(readTlv(b, 0), b)[1]!;
  const sd = children(children(token, b)[1]!, b)[0]!;
  const parts = children(sd, b);
  const eContent = children(children(parts[2]!, b)[1]!, b)[0]!;
  const si = children(children(parts.at(-1)!, b)[0]!, b);
  const cert = b.indexOf(signerCertDer);
  return [[eContent.start, eContent.end], [si[3]!.start, si[3]!.end], [si[5]!.start, si[5]!.end], [cert, cert + signerCertDer.length]];
}

/** Stored next to a tree head. */
export const TimestampFile = z
  .object({
    schema: z.literal("tdp-timestamp/0.1"),
    /** treeHeadDigest of the head this timestamps. */
    headSha256: z.string().regex(/^[0-9a-f]{64}$/),
    tsaUrl: z.string().url(),
    nonce: z.string().regex(/^[0-9a-f]+$/),
    response: z.string().min(1).max(200_000),
  })
  .strict();
export type TimestampFile = z.infer<typeof TimestampFile>;

/** Asks a TSA for a timestamp over `digestHex`, and verifies the answer before returning it. */
export async function requestTimestamp(tsaUrl: string, digestHex: string, trusted: X509Certificate[], fetcher: typeof fetch = fetch): Promise<{ file: TimestampFile; result: TimestampResult }> {
  if (!/^https?:\/\//.test(tsaUrl)) throw new Error("TSA URL must be http(s)");
  const req = timestampRequest(digestHex);
  const res = await fetcher(tsaUrl, { method: "POST", headers: { "Content-Type": "application/timestamp-query" }, body: new Uint8Array(req.der) });
  if (!res.ok) throw new Error(`TSA answered HTTP ${res.status}`);
  const der = Buffer.from(await res.arrayBuffer());
  const result = verifyTimestamp(der, digestHex, trusted, req.nonce);
  return { file: { schema: "tdp-timestamp/0.1", headSha256: digestHex, tsaUrl, nonce: req.nonce, response: der.toString("base64") }, result };
}

export function verifyTimestampFile(f: TimestampFile, headSha256: string, trusted: X509Certificate[]): TimestampResult {
  if (f.headSha256 !== headSha256) throw new Error("timestamp is for a different tree head");
  return verifyTimestamp(Buffer.from(f.response, "base64"), headSha256, trusted, f.nonce);
}

/** Loads pinned TSA certificates from PEM text (one or more) or DER. */
export function loadTsaCertificates(data: Buffer): X509Certificate[] {
  const text = data.toString("latin1");
  const pems = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  return pems ? pems.map((p) => new X509Certificate(p)) : [new X509Certificate(data)];
}
