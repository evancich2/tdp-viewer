import { readArchive, checkPath, ArchiveError, type ArchiveEntry } from "./archive";
import { digestEquals, sha256Hex, utf8 } from "./bytes";
import type { Policy } from "./policy";
import { Manifest, SignatureFile, TrustStore, type Signature, type SignerRole, type TrustedKey } from "./schema";
import { keyIdFor, verifyEd25519 } from "./signing";

export const MANIFEST_PATH = "tdp-manifest.json";
export const SIGNATURES_PATH = "tdp-manifest.sig.json";

export type CheckStatus = "pass" | "fail";

export interface Check {
  id: string;
  status: CheckStatus;
  message: string;
}

export interface FileResult {
  path: string;
  ok: boolean;
  problems: string[];
}

export interface VerifyResult {
  /** "trusted" only when every check passed. There is no partial trust. */
  verdict: "trusted" | "rejected";
  checks: Check[];
  manifest?: Manifest;
  manifestSha256?: string;
  files: FileResult[];
  /** Archive bytes, kept only so a trusted package can be opened. */
  entries: ArchiveEntry[];
}

/**
 * The exact bytes each signer signs. It binds the role and time to the manifest digest,
 * so a signature can't be relabeled with a different role or moved to another manifest.
 */
export function signingMessage(manifestSha256: string, role: SignerRole, signedAt: string): Uint8Array {
  return utf8.encode(`tdp-signature/0.1\n${role}\n${signedAt}\n${manifestSha256}`);
}

/** Parses a trust store and rejects any key whose id doesn't match its public key. */
export async function loadTrustStore(json: string): Promise<TrustStore> {
  const store = TrustStore.parse(JSON.parse(json));
  for (const key of store.keys) {
    if ((await keyIdFor(key.publicKey)) !== key.keyId) throw new Error(`trust store: key id mismatch for ${key.name}`);
  }
  return store;
}

function parseJsonEntry<T>(bytes: Uint8Array, parse: (v: unknown) => T): T {
  return parse(JSON.parse(utf8.decode(bytes)));
}

export async function verifyPackage(
  data: Uint8Array,
  trustStore: TrustStore,
  policy: Policy,
  now: Date = new Date(),
): Promise<VerifyResult> {
  const checks: Check[] = [];
  const pass = (id: string, message: string) => checks.push({ id, status: "pass", message });
  const fail = (id: string, message: string) => checks.push({ id, status: "fail", message });
  const rejected = (entries: ArchiveEntry[] = [], extra: Partial<VerifyResult> = {}): VerifyResult => ({
    verdict: "rejected",
    checks,
    files: [],
    entries,
    ...extra,
  });

  // 1. Container
  let entries: ArchiveEntry[];
  try {
    entries = readArchive(data, policy);
    pass("archive", `${entries.length} entries within size limits`);
  } catch (e) {
    fail("archive", e instanceof ArchiveError ? e.message : `unreadable package: ${(e as Error).message}`);
    return rejected();
  }
  const byPath = new Map(entries.map((e) => [e.path, e]));

  // 2. Manifest
  const manifestEntry = byPath.get(MANIFEST_PATH);
  if (!manifestEntry) {
    fail("manifest", `${MANIFEST_PATH} missing`);
    return rejected(entries);
  }
  let manifest: Manifest;
  try {
    manifest = parseJsonEntry(manifestEntry.bytes, (v) => Manifest.parse(v));
    pass("manifest", `manifest for ${manifest.package.partNumber} rev ${manifest.package.revision}`);
  } catch (e) {
    fail("manifest", `invalid manifest: ${(e as Error).message}`);
    return rejected(entries);
  }
  const manifestSha256 = await sha256Hex(manifestEntry.bytes);

  // 3. Signatures: required roles must each be covered by a different trusted key.
  const sigEntry = byPath.get(SIGNATURES_PATH);
  let sigFile: SignatureFile | undefined;
  if (!sigEntry) fail("signatures", `${SIGNATURES_PATH} missing`);
  else {
    try {
      sigFile = parseJsonEntry(sigEntry.bytes, (v) => SignatureFile.parse(v));
    } catch (e) {
      fail("signatures", `invalid signature file: ${(e as Error).message}`);
    }
  }
  if (sigFile) {
    if (!digestEquals(sigFile.manifestSha256, manifestSha256)) {
      fail("signatures", "signatures were made over a different manifest");
    } else {
      const covered = new Map<SignerRole, string>();
      const usedKeys = new Set<string>();
      for (const sig of sigFile.signatures) {
        const problem = await checkSignature(sig, manifestSha256, trustStore.keys, now, policy.clockSkewMs);
        const label = `${sig.role} signature by ${sig.keyId}`;
        if (problem) {
          fail(`signature:${sig.keyId}:${sig.role}`, `${label}: ${problem}`);
          continue;
        }
        const key = trustStore.keys.find((k) => k.keyId === sig.keyId)!;
        pass(`signature:${sig.keyId}:${sig.role}`, `${sig.role} signature by ${key.name} is valid`);
        if (!covered.has(sig.role) && !usedKeys.has(sig.keyId)) {
          covered.set(sig.role, sig.keyId);
          usedKeys.add(sig.keyId);
        }
      }
      const missing = policy.requiredRoles.filter((r) => !covered.has(r));
      if (missing.length) fail("signatures", `no valid signature from a distinct key for: ${missing.join(", ")}`);
      else pass("signatures", `required roles signed by distinct keys: ${policy.requiredRoles.join(", ")}`);
    }
  }

  // 4. Package validity window
  const created = Date.parse(manifest.package.created);
  if (created > now.getTime() + policy.clockSkewMs) fail("validity", "package creation time is in the future");
  else if (manifest.package.expires && Date.parse(manifest.package.expires) < now.getTime())
    fail("validity", `package expired ${manifest.package.expires}`);
  else pass("validity", manifest.package.expires ? `valid until ${manifest.package.expires}` : "no expiry set");

  // 5-6. Contents and BOM
  const contents = await checkContents(manifest, entries, policy);
  checks.push(...contents.checks);
  const files = contents.files;

  const verdict = checks.every((c) => c.status === "pass") ? "trusted" : "rejected";
  return { verdict, checks, manifest, manifestSha256, files, entries };
}

/**
 * Checks that the archive holds exactly the files the manifest lists, each matching its size,
 * digest and allowed media type, and that the BOM's references resolve. Signers run this too,
 * so nobody signs a manifest without checking what it describes.
 */
export async function checkContents(
  manifest: Manifest,
  entries: ArchiveEntry[],
  policy: Policy,
): Promise<{ checks: Check[]; files: FileResult[] }> {
  const checks: Check[] = [];
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const listed = new Map(manifest.files.map((f) => [f.path, f]));
  const files: FileResult[] = [];
  for (const entry of entries) {
    if (entry.path === MANIFEST_PATH || entry.path === SIGNATURES_PATH) continue;
    if (!listed.has(entry.path)) files.push({ path: entry.path, ok: false, problems: ["not listed in manifest"] });
  }
  const seen = new Set<string>();
  for (const f of manifest.files) {
    const problems: string[] = [];
    const pathProblem = checkPath(f.path);
    const entry = byPath.get(f.path);
    if (seen.has(f.path)) problems.push("listed more than once");
    seen.add(f.path);
    if (pathProblem) problems.push(pathProblem);
    if (f.path === MANIFEST_PATH || f.path === SIGNATURES_PATH) problems.push("reserved path");
    if (!entry) problems.push("missing from package");
    else {
      if (entry.bytes.length !== f.size) problems.push(`size ${entry.bytes.length}, manifest says ${f.size}`);
      if (!digestEquals(await sha256Hex(entry.bytes), f.sha256)) problems.push("SHA-256 does not match manifest");
      const magic = policy.allowedMediaTypes[f.mediaType];
      if (!magic) problems.push(`media type ${f.mediaType} not allowed by policy`);
      else if (!magic(entry.bytes.subarray(0, 1024))) problems.push(`content is not ${f.mediaType}`);
    }
    files.push({ path: f.path, ok: problems.length === 0, problems });
  }
  const badFiles = files.filter((f) => !f.ok);
  checks.push(
    badFiles.length
      ? { id: "contents", status: "fail", message: `${badFiles.length} of ${files.length} files failed` }
      : { id: "contents", status: "pass", message: `all ${files.length} files match the manifest` },
  );

  const bomProblems = checkBom(manifest, listed);
  checks.push(
    bomProblems.length
      ? { id: "bom", status: "fail", message: bomProblems.join("; ") }
      : { id: "bom", status: "pass", message: `${manifest.bom.length} BOM items, references resolve` },
  );
  return { checks, files };
}

async function checkSignature(
  sig: Signature,
  manifestSha256: string,
  keys: TrustedKey[],
  now: Date,
  skew: number,
): Promise<string | null> {
  const key = keys.find((k) => k.keyId === sig.keyId);
  if (!key) return "key is not in the trust store";
  if (key.revoked) return "key is revoked";
  if (!key.roles.includes(sig.role)) return `key is not authorized for the ${sig.role} role`;
  const signedAt = Date.parse(sig.signedAt);
  const from = Date.parse(key.notBefore) - skew;
  const to = Date.parse(key.notAfter) + skew;
  if (signedAt > now.getTime() + skew) return "signing time is in the future";
  if (signedAt < from || signedAt > to) return "signed outside the key's validity window";
  if (now.getTime() < from || now.getTime() > to) return "key is not currently valid";
  const ok = await verifyEd25519(key.publicKey, sig.sig, signingMessage(manifestSha256, sig.role, sig.signedAt));
  return ok ? null : "signature does not verify";
}

function checkBom(manifest: Manifest, listed: Map<string, unknown>): string[] {
  const problems: string[] = [];
  const parts = new Map(manifest.bom.map((b) => [b.partNumber, b]));
  if (parts.size !== manifest.bom.length) problems.push("duplicate part number in BOM");
  for (const item of manifest.bom) {
    for (const f of item.files) if (!listed.has(f)) problems.push(`${item.partNumber} references unlisted file ${f}`);
    if (item.parent && !parts.has(item.parent)) problems.push(`${item.partNumber} has unknown parent ${item.parent}`);
  }
  // Walk each item up to the root; a walk longer than the BOM means a cycle.
  for (const item of manifest.bom) {
    let cur: string | undefined = item.partNumber;
    for (let steps = 0; cur; steps++) {
      if (steps > parts.size) {
        problems.push(`cycle in BOM at ${item.partNumber}`);
        break;
      }
      cur = parts.get(cur)?.parent;
    }
  }
  return problems;
}
