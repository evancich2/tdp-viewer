import { zipSync } from "fflate";
import { sha256Hex, utf8 } from "./bytes";
import type { BomItem, Manifest, ManifestFile, SignatureFile, SignerRole } from "./schema";
import { signEd25519 } from "./signing";
import { MANIFEST_PATH, SIGNATURES_PATH, signingMessage } from "./verify";

export interface PackInput {
  path: string;
  bytes: Uint8Array;
  mediaType: string;
  role: ManifestFile["role"];
  partNumber?: string;
  revision?: string;
}

export interface Signer {
  keyId: string;
  privateKey: CryptoKey;
  role: SignerRole;
}

export async function buildManifest(
  pkg: Manifest["package"],
  inputs: PackInput[],
  bom: BomItem[] = [],
): Promise<Manifest> {
  const files: ManifestFile[] = [];
  for (const { bytes, ...meta } of inputs) {
    files.push({ ...meta, size: bytes.length, sha256: await sha256Hex(bytes) });
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
    const sig = await signEd25519(s.privateKey, signingMessage(manifestSha256, s.role, signedAt));
    signatures.push({ keyId: s.keyId, alg: "Ed25519" as const, role: s.role, signedAt, sig });
  }
  return { schema: "tdp-signatures/0.1", manifestSha256, signatures };
}

/** Builds a complete signed .tdp zip. The manifest bytes that get signed are the bytes that get stored. */
export async function buildPackage(
  pkg: Manifest["package"],
  inputs: PackInput[],
  bom: BomItem[],
  signers: Signer[],
  now?: Date,
): Promise<Uint8Array> {
  const manifestBytes = utf8.encode(JSON.stringify(await buildManifest(pkg, inputs, bom), null, 2));
  const sigFile = await signManifest(manifestBytes, signers, now);
  const zipFiles: Record<string, Uint8Array> = {
    [MANIFEST_PATH]: manifestBytes,
    [SIGNATURES_PATH]: utf8.encode(JSON.stringify(sigFile, null, 2)),
  };
  for (const f of inputs) zipFiles[f.path] = f.bytes;
  return zipSync(zipFiles);
}
