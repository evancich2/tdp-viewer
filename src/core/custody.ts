import { z } from "zod";
import { sha256Hex, toHex, utf8 } from "./bytes";
import type { TrustStore } from "./schema";
import { signWith, verifyEd25519, type KeyHandle } from "./signing";
import type { LedgerResult } from "./records";

// Merkle custody log over a workflow ledger (Certificate Transparency style, RFC 9162 §2.1).
// Leaves are the SHA-256 digests of the ledger's records, in order. A signed tree head (STH) commits
// to every record so far. Parties that don't trust the ledger's holder keep the heads they have
// seen (a witness file) and can then prove, offline:
//   - truncation or rewriting: a ledger whose first N records don't reproduce a witnessed head;
//   - a fork: two validly signed heads of the same size with different roots;
//   - honest growth: a consistency proof shows a newer head extends an older one, without the ledger.
// What it does not do by itself: say *when*. A head's `issuedAt` is the signer's claim; an RFC 3161
// timestamp over the head (tools/timestamp.ts) is what bounds time.

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const keyId = z.string().regex(/^[0-9a-f]{32}$/);
const isoTime = z.string().datetime({ offset: true });

const hexBytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const H = async (...parts: Uint8Array[]) => {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return hexBytes(await sha256Hex(all));
};
const leafHash = (recordSha256: string) => H(new Uint8Array([0]), hexBytes(recordSha256));
const nodeHash = (l: Uint8Array, r: Uint8Array) => H(new Uint8Array([1]), l, r);
const largestPow2Below = (n: number) => { let k = 1; while (k * 2 < n) k *= 2; return k; };

/** Merkle tree hash of the leaves (record digests). MTH({}) is SHA-256 of nothing. */
export async function treeHash(leaves: readonly string[]): Promise<string> {
  return toHex(await mth(leaves));
}
async function mth(d: readonly string[]): Promise<Uint8Array> {
  if (d.length === 0) return H();
  if (d.length === 1) return leafHash(d[0]!);
  const k = largestPow2Below(d.length);
  return nodeHash(await mth(d.slice(0, k)), await mth(d.slice(k)));
}

/** Audit path for leaf `m` in the tree of `leaves` (RFC 6962 PATH). */
export async function inclusionProof(m: number, leaves: readonly string[]): Promise<string[]> {
  if (m < 0 || m >= leaves.length) throw new Error("leaf index out of range");
  const path = async (m: number, d: readonly string[]): Promise<Uint8Array[]> => {
    if (d.length <= 1) return [];
    const k = largestPow2Below(d.length);
    return m < k ? [...(await path(m, d.slice(0, k))), await mth(d.slice(k))] : [...(await path(m - k, d.slice(k))), await mth(d.slice(0, k))];
  };
  return (await path(m, leaves)).map(toHex);
}

/** Consistency proof that the tree of the first `m` leaves is a prefix of the tree of all `leaves` (RFC 6962 PROOF). */
export async function consistencyProof(m: number, leaves: readonly string[]): Promise<string[]> {
  if (m < 1 || m > leaves.length) throw new Error("old size out of range");
  const subproof = async (m: number, d: readonly string[], b: boolean): Promise<Uint8Array[]> => {
    if (m === d.length) return b ? [] : [await mth(d)];
    const k = largestPow2Below(d.length);
    return m <= k ? [...(await subproof(m, d.slice(0, k), b)), await mth(d.slice(k))] : [...(await subproof(m - k, d.slice(k), false)), await mth(d.slice(0, k))];
  };
  return (await subproof(m, leaves, true)).map(toHex);
}

/** RFC 9162 §2.1.3.2: does `proof` show leaf `index` with digest `recordSha256` is in the tree of `size` with `root`? */
export async function verifyInclusion(recordSha256: string, index: number, size: number, root: string, proof: readonly string[]): Promise<boolean> {
  if (index >= size) return false;
  let fn = index;
  let sn = size - 1;
  let r = await leafHash(recordSha256);
  for (const p of proof) {
    if (sn === 0) return false;
    const pb = hexBytes(p);
    if (fn % 2 === 1 || fn === sn) {
      r = await nodeHash(pb, r);
      if (fn % 2 === 0) while (fn % 2 === 0 && fn !== 0) { fn >>= 1; sn >>= 1; }
    } else r = await nodeHash(r, pb);
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && toHex(r) === root;
}

/** RFC 9162 §2.1.4.2: does `proof` show the tree (size1, root1) is a prefix of (size2, root2)? */
export async function verifyConsistency(size1: number, root1: string, size2: number, root2: string, proof: readonly string[]): Promise<boolean> {
  if (size1 > size2) return false;
  if (size1 === size2) return proof.length === 0 && root1 === root2;
  if (size1 === 0) return proof.length === 0;
  let path = proof.map(hexBytes);
  if ((size1 & (size1 - 1)) === 0) path = [hexBytes(root1), ...path];
  if (!path.length) return false;
  let fn = size1 - 1;
  let sn = size2 - 1;
  while (fn % 2 === 1) { fn >>= 1; sn >>= 1; }
  let fr = path[0]!;
  let sr = path[0]!;
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      fr = await nodeHash(c, fr);
      sr = await nodeHash(c, sr);
      if (fn % 2 === 0) while (fn % 2 === 0 && fn !== 0) { fn >>= 1; sn >>= 1; }
    } else sr = await nodeHash(sr, c);
    fn >>= 1;
    sn >>= 1;
  }
  return toHex(fr) === root1 && toHex(sr) === root2 && sn === 0;
}

// ---- Signed tree heads and witness files ----

export const TreeHead = z
  .object({
    schema: z.literal("tdp-tree-head/0.1"),
    instance: z.string().uuid(),
    packageId: z.string().uuid(),
    manifestSha256: sha256,
    treeSize: z.number().int().nonnegative(),
    rootHash: sha256,
    /** The signer's claim of when it saw this state. An RFC 3161 timestamp bounds it independently. */
    issuedAt: isoTime,
    signature: z.object({ keyId, alg: z.literal("Ed25519"), sig: z.string().min(1).max(200) }).strict(),
  })
  .strict();
export type TreeHead = z.infer<typeof TreeHead>;

export const Witness = z.object({ schema: z.literal("tdp-witness/0.1"), heads: z.array(TreeHead).max(100_000) }).strict();
export type Witness = z.infer<typeof Witness>;

export const treeHeadMessage = (h: Omit<TreeHead, "signature" | "schema">) =>
  utf8.encode(`tdp-tree-head/0.1\n${h.instance}\n${h.packageId}\n${h.manifestSha256}\n${h.treeSize}\n${h.rootHash}\n${h.issuedAt}`);

/** Digest that identifies a head (and that an RFC 3161 timestamp is requested over). */
export const treeHeadDigest = async (h: TreeHead) => sha256Hex(treeHeadMessage(h));

export const leavesOf = (r: LedgerResult) => r.records.map((v) => v.sha256);

/** Signs a head over the ledger's first `size` records (all of them by default). Only a ledger that verifies can be committed to. */
export async function signTreeHead(r: LedgerResult, signer: KeyHandle, opts: { size?: number; now?: Date } = {}): Promise<TreeHead> {
  if (r.verdict === "rejected" || !r.instance) throw new Error("only a ledger that verifies can get a tree head");
  const leaves = leavesOf(r).slice(0, opts.size ?? r.records.length);
  if (opts.size !== undefined && leaves.length !== opts.size) throw new Error(`ledger has only ${r.records.length} records`);
  const body = { instance: r.instance.id, packageId: r.instance.packageId, manifestSha256: r.instance.manifestSha256, treeSize: leaves.length, rootHash: await treeHash(leaves), issuedAt: (opts.now ?? new Date()).toISOString() };
  return { schema: "tdp-tree-head/0.1", ...body, signature: { keyId: signer.keyId, alg: "Ed25519", sig: await signWith(signer, treeHeadMessage(body)) } };
}

/** A head's signature, by a trusted, unrevoked key. Returns the signer's name and organization. */
export async function checkTreeHead(h: TreeHead, trustStore: TrustStore): Promise<{ signer?: string; organization?: string; problem?: string }> {
  const key = trustStore.keys.find((k) => k.keyId === h.signature.keyId);
  if (!key) return { problem: `tree head signer ${h.signature.keyId} is not in the trust store` };
  if (key.revoked) return { problem: `${key.name}'s key is revoked` };
  const t = Date.parse(h.issuedAt);
  if (t < Date.parse(key.notBefore) || t > Date.parse(key.notAfter)) return { problem: `${key.name}'s key was not valid at ${h.issuedAt}` };
  if (!(await verifyEd25519(key.publicKey, h.signature.sig, treeHeadMessage(h)))) return { problem: "tree head signature does not verify" };
  return { signer: key.name, organization: key.organization?.name };
}

export interface HeadCheck {
  head: TreeHead;
  signer?: string;
  organization?: string;
  status: "consistent" | "truncated" | "rewritten" | "wrong-ledger" | "bad-signature";
  message: string;
}

/**
 * Checks a ledger against witnessed heads: the ledger must still contain, unchanged, every history
 * a trusted party signed a head over. This is what detects dropped newest records.
 */
export async function checkLedgerAgainstHeads(r: LedgerResult, heads: readonly TreeHead[], trustStore: TrustStore): Promise<HeadCheck[]> {
  const leaves = leavesOf(r);
  const out: HeadCheck[] = [];
  for (const head of heads) {
    const sig = await checkTreeHead(head, trustStore);
    const who = sig.signer ? `${sig.signer}${sig.organization ? ` (${sig.organization})` : ""}` : head.signature.keyId;
    const base = { head, signer: sig.signer, organization: sig.organization };
    if (sig.problem) { out.push({ ...base, status: "bad-signature", message: sig.problem }); continue; }
    if (!r.instance || head.instance !== r.instance.id || head.manifestSha256 !== r.instance.manifestSha256) { out.push({ ...base, status: "wrong-ledger", message: `head is for instance ${head.instance}` }); continue; }
    if (leaves.length < head.treeSize) { out.push({ ...base, status: "truncated", message: `${who} signed a head over ${head.treeSize} records; this ledger has ${leaves.length} verified records: history was truncated` }); continue; }
    const root = await treeHash(leaves.slice(0, head.treeSize));
    if (root !== head.rootHash) { out.push({ ...base, status: "rewritten", message: `the first ${head.treeSize} records don't match the head ${who} signed: history was rewritten or forked` }); continue; }
    out.push({ ...base, status: "consistent", message: `contains the ${head.treeSize}-record history ${who} signed at ${head.issuedAt}` });
  }
  return out;
}

/** Two validly signed heads of the same instance and size with different roots prove a fork, with no ledger needed. */
export function findForks(heads: readonly TreeHead[]): [TreeHead, TreeHead][] {
  const forks: [TreeHead, TreeHead][] = [];
  for (let i = 0; i < heads.length; i++)
    for (let j = i + 1; j < heads.length; j++) {
      const [a, b] = [heads[i]!, heads[j]!];
      if (a.instance === b.instance && a.treeSize === b.treeSize && a.rootHash !== b.rootHash) forks.push([a, b]);
    }
  return forks;
}

/**
 * Adds a head to a witness file after checking its signature, that it doesn't fork any head already
 * held, and (when given) a consistency proof from the newest held head of that instance.
 */
export async function witnessHead(w: Witness, head: TreeHead, trustStore: TrustStore, proof?: readonly string[]): Promise<Witness> {
  const sig = await checkTreeHead(head, trustStore);
  if (sig.problem) throw new Error(sig.problem);
  const fork = findForks([...w.heads, head]).find(([a, b]) => a === head || b === head);
  if (fork) throw new Error(`fork: a head of size ${head.treeSize} with a different root is already witnessed (signed by ${fork[0] === head ? fork[1].signature.keyId : fork[0].signature.keyId})`);
  const prior = w.heads.filter((h) => h.instance === head.instance && h.treeSize < head.treeSize).sort((a, b) => b.treeSize - a.treeSize)[0];
  if (prior) {
    if (!proof) throw new Error(`a consistency proof from the held ${prior.treeSize}-record head is required`);
    if (!(await verifyConsistency(prior.treeSize, prior.rootHash, head.treeSize, head.rootHash, proof))) throw new Error(`consistency proof from size ${prior.treeSize} to ${head.treeSize} does not verify: the new head doesn't extend the old one`);
  }
  if (w.heads.some((h) => h.instance === head.instance && h.treeSize === head.treeSize && h.rootHash === head.rootHash && h.signature.keyId === head.signature.keyId)) return w;
  return { ...w, heads: [...w.heads, head] };
}

export const ConsistencyProofFile = z
  .object({ schema: z.literal("tdp-consistency-proof/0.1"), instance: z.string().uuid(), fromSize: z.number().int().positive(), toSize: z.number().int().positive(), proof: z.array(sha256) })
  .strict();
export type ConsistencyProofFile = z.infer<typeof ConsistencyProofFile>;

