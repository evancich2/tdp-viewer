import { zipSync } from "fflate";
import { sha256Hex, utf8 } from "./bytes";
import type { BomItem, Manifest, ManifestFile, ManifestPackage, SignatureFile, SignerRole } from "./schema";
import { signWith, type KeyHandle } from "./signing";
import { MANIFEST_PATH, SIGNATURES_PATH, signingMessage } from "./verify";

export interface PackInput {
  path: string;
  bytes: Uint8Array;
  mediaType: string;
  role: ManifestFile["role"];
  partNumber?: string;
  revision?: string;
}

export type Signer = KeyHandle & { role: SignerRole };

export interface ManifestOptions {
  /**
   * Path of the canonical engineering model (one of the inputs). Setting it produces a
   * `tdp-manifest/0.2` manifest; leaving it out produces the original `tdp-manifest/0.1`.
   */
  engineering?: string;
}

export async function buildManifest(
  pkg: ManifestPackage,
  inputs: PackInput[],
  bom: BomItem[] = [],
  opts: ManifestOptions = {},
): Promise<Manifest> {
  const files: ManifestFile[] = [];
  for (const { bytes, ...meta } of inputs) {
    files.push({ ...meta, size: bytes.length, sha256: await sha256Hex(bytes) });
  }
  if (opts.engineering) {
    if (!files.some((f) => f.path === opts.engineering)) throw new Error(`engineering model ${opts.engineering} is not among the files`);
    return { schema: "tdp-manifest/0.2", package: pkg, files, bom, engineering: { path: opts.engineering, schema: "tdp-engineering/0.1" } };
  }
  return { schema: "tdp-manifest/0.1", package: pkg, files, bom };
}

export async function signManifest(
  manifestBytes: Uint8Array,
  signers: Signer[],
  now: Date = new Date(),
): Promise<SignatureFile> {
  const manifestSha256 = await sha256Hex(manifestBytes);
  const signedAt = now.toISOString();
  const signatures = [];
  for (const s of signers) {
    const sig = await signWith(s, signingMessage(manifestSha256, s.role, signedAt));
    signatures.push({ keyId: s.keyId, alg: "Ed25519" as const, role: s.role, signedAt, sig });
  }
  return { schema: "tdp-signatures/0.1", manifestSha256, signatures };
}

/** Builds a complete signed .tdp zip. The manifest bytes that get signed are the bytes that get stored. */
export async function buildPackage(
  pkg: ManifestPackage,
  inputs: PackInput[],
  bom: BomItem[],
  signers: Signer[],
  now?: Date,
  opts: ManifestOptions = {},
): Promise<Uint8Array> {
  const manifestBytes = utf8.encode(JSON.stringify(await buildManifest(pkg, inputs, bom, opts), null, 2));
  const sigFile = await signManifest(manifestBytes, signers, now);
  const zipFiles: Record<string, Uint8Array> = {
    [MANIFEST_PATH]: manifestBytes,
    [SIGNATURES_PATH]: utf8.encode(JSON.stringify(sigFile, null, 2)),
  };
  for (const f of inputs) zipFiles[f.path] = f.bytes;
  return zipSync(zipFiles);
}
