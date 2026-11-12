// CLI command implementations, kept separate from argument parsing so they can be tested directly.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { z } from "zod";
import { readArchive } from "../src/core/archive";
import { sha256Hex, utf8 } from "../src/core/bytes";
import { buildManifest, type PackInput } from "../src/core/pack";
import type { Policy } from "../src/core/policy";
import { BomItem, FileRole, Manifest, SignatureFile, TrustStore, type SignerRole } from "../src/core/schema";
import { signEd25519 } from "../src/core/signing";
import { MANIFEST_PATH, SIGNATURES_PATH, checkContents, signingMessage } from "../src/core/verify";

/** `tdp-package.json`: what `tdp pack` reads from the source folder. */
export const PackageSpec = z
  .object({
    package: Manifest.shape.package.omit({ id: true, created: true }).extend({ id: z.string().uuid().optional() }),
    files: z
      .record(
        z.string(),
        z.object({ role: FileRole.optional(), partNumber: z.string().optional(), revision: z.string().optional(), mediaType: z.string().optional() }).strict(),
      )
      .default({}),
    bom: z.array(BomItem).default([]),
  })
  .strict();
export type PackageSpec = z.infer<typeof PackageSpec>;
export const SPEC_FILE = "tdp-package.json";

const BY_EXTENSION: Record<string, { mediaType: string; role: FileRole }> = {
  pdf: { mediaType: "application/pdf", role: "drawing" },
  stp: { mediaType: "model/step", role: "model" },
  step: { mediaType: "model/step", role: "model" },
  csv: { mediaType: "text/csv", role: "bom" },
  json: { mediaType: "application/json", role: "other" },
  txt: { mediaType: "text/plain", role: "spec" },
};

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name.startsWith(".")) return [];
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
}

/**
 * Builds an unsigned package from a folder. Every file in the folder is included (except the spec
 * and dotfiles); media type and role come from the extension unless the spec overrides them.
 */
export async function pack(dir: string, now = new Date()): Promise<Uint8Array> {
  const spec = PackageSpec.parse(JSON.parse(readFileSync(join(dir, SPEC_FILE), "utf8")));
  const inputs: PackInput[] = [];
  for (const full of listFiles(dir).sort()) {
    const path = relative(dir, full).split(sep).join("/");
    if (path === SPEC_FILE) continue;
    const ext = path.split(".").pop()!.toLowerCase();
    const over = spec.files[path] ?? {};
    const guess = BY_EXTENSION[ext];
    const mediaType = over.mediaType ?? guess?.mediaType;
    if (!mediaType) throw new Error(`${path}: unknown file type; set mediaType in ${SPEC_FILE}`);
    inputs.push({
      path,
      bytes: new Uint8Array(readFileSync(full)),
      mediaType,
      role: over.role ?? guess?.role ?? "other",
      partNumber: over.partNumber,
      revision: over.revision,
    });
  }
  const unknown = Object.keys(spec.files).filter((p) => !inputs.some((i) => i.path === p));
  if (unknown.length) throw new Error(`${SPEC_FILE} describes files that aren't in the folder: ${unknown.join(", ")}`);

  const manifest = await buildManifest(
    { ...spec.package, id: spec.package.id ?? crypto.randomUUID(), created: now.toISOString() },
    inputs,
    spec.bom,
  );
  Manifest.parse(manifest);
  const zipFiles: Record<string, Uint8Array> = { [MANIFEST_PATH]: utf8.encode(JSON.stringify(manifest, null, 2)) };
  for (const f of inputs) zipFiles[f.path] = f.bytes;
  return zipSync(zipFiles);
}

/**
 * Adds one signature to a package. The signer's tool checks the contents against the manifest
 * first and refuses to sign if anything is off. Existing signatures are kept; the file data and
 * manifest bytes are never rewritten.
 */
export async function sign(
  tdp: Uint8Array,
  key: { keyId: string; privateKey: CryptoKey },
  role: SignerRole,
  policy: Policy,
  now = new Date(),
): Promise<Uint8Array> {
  const entries = readArchive(tdp, policy);
  const manifestEntry = entries.find((e) => e.path === MANIFEST_PATH);
  if (!manifestEntry) throw new Error(`${MANIFEST_PATH} missing`);
  const manifest = Manifest.parse(JSON.parse(utf8.decode(manifestEntry.bytes)));
  const { checks, files } = await checkContents(manifest, entries, policy);
  const failed = checks.filter((c) => c.status === "fail");
  if (failed.length) {
    const detail = files.filter((f) => !f.ok).map((f) => `${f.path}: ${f.problems.join("; ")}`);
    throw new Error(`refusing to sign: ${[...failed.map((c) => c.message), ...detail].join("\n  ")}`);
  }

  const manifestSha256 = await sha256Hex(manifestEntry.bytes);
  const existing = entries.find((e) => e.path === SIGNATURES_PATH);
  const previous = existing ? SignatureFile.parse(JSON.parse(utf8.decode(existing.bytes))) : null;
  if (previous && previous.manifestSha256 !== manifestSha256) throw new Error("existing signatures are for a different manifest");
  const signatures = previous?.signatures ?? [];
  if (signatures.some((s) => s.keyId === key.keyId && s.role === role)) throw new Error(`already signed by this key as ${role}`);

  const signedAt = now.toISOString();
  const sig = await signEd25519(key.privateKey, signingMessage(manifestSha256, role, signedAt));
  const sigFile: SignatureFile = {
    schema: "tdp-signatures/0.1",
    manifestSha256,
    signatures: [...signatures, { keyId: key.keyId, alg: "Ed25519", role, signedAt, sig }],
  };

  const files2 = unzipSync(tdp);
  files2[SIGNATURES_PATH] = utf8.encode(JSON.stringify(sigFile, null, 2));
  return zipSync(files2);
}

export function addToTrustStore(storeJson: string | null, entryJson: string): TrustStore {
  const store: TrustStore = storeJson ? TrustStore.parse(JSON.parse(storeJson)) : { schema: "tdp-truststore/0.1", keys: [] };
  const entry = TrustStore.shape.keys.element.parse(JSON.parse(entryJson));
  if (store.keys.some((k) => k.keyId === entry.keyId)) throw new Error(`key ${entry.keyId} is already in the trust store`);
  store.keys.push(entry);
  return store;
}

export function revokeInTrustStore(storeJson: string, keyId: string): TrustStore {
  const store = TrustStore.parse(JSON.parse(storeJson));
  const key = store.keys.find((k) => k.keyId === keyId);
  if (!key) throw new Error(`key ${keyId} is not in the trust store`);
  key.revoked = true;
  return store;
}
