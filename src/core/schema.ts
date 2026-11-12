import { z } from "zod";

// All schemas are .strict(): unknown fields are rejected, not ignored.
// A zero-trust parser does not guess what an unexpected field means.

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "lowercase hex SHA-256");
const isoTime = z.string().datetime({ offset: true });
const partNumber = z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/);
const revision = z.string().min(1).max(16).regex(/^[A-Za-z0-9.-]+$/);

export const FileRole = z.enum(["drawing", "model", "bom", "spec", "other"]);
export type FileRole = z.infer<typeof FileRole>;

export const ManifestFile = z
  .object({
    path: z.string().min(1).max(255),
    sha256,
    size: z.number().int().nonnegative(),
    mediaType: z.string().min(1).max(100),
    role: FileRole,
    partNumber: partNumber.optional(),
    revision: revision.optional(),
  })
  .strict();
export type ManifestFile = z.infer<typeof ManifestFile>;

export const BomItem = z
  .object({
    partNumber,
    revision,
    name: z.string().min(1).max(200),
    quantity: z.number().positive(),
    parent: partNumber.optional(),
    files: z.array(z.string()).default([]),
  })
  .strict();
export type BomItem = z.infer<typeof BomItem>;

export const Manifest = z
  .object({
    schema: z.literal("tdp-manifest/0.1"),
    package: z
      .object({
        id: z.string().uuid(),
        title: z.string().min(1).max(200),
        partNumber,
        revision,
        created: isoTime,
        expires: isoTime.optional(),
        distribution: z.string().max(500).optional(),
      })
      .strict(),
    files: z.array(ManifestFile).min(1).max(10_000),
    bom: z.array(BomItem).max(100_000).default([]),
  })
  .strict();
export type Manifest = z.infer<typeof Manifest>;

export const SignerRole = z.enum(["author", "checker", "approver", "release"]);
export type SignerRole = z.infer<typeof SignerRole>;

export const Signature = z
  .object({
    keyId: z.string().regex(/^[0-9a-f]{32}$/),
    alg: z.literal("Ed25519"),
    role: SignerRole,
    signedAt: isoTime,
    sig: z.string().min(1).max(200),
  })
  .strict();
export type Signature = z.infer<typeof Signature>;

export const SignatureFile = z
  .object({
    schema: z.literal("tdp-signatures/0.1"),
    manifestSha256: sha256,
    signatures: z.array(Signature).min(1).max(32),
  })
  .strict();
export type SignatureFile = z.infer<typeof SignatureFile>;

export const TrustedKey = z
  .object({
    keyId: z.string().regex(/^[0-9a-f]{32}$/),
    name: z.string().min(1).max(200),
    publicKey: z.string().min(1).max(100),
    roles: z.array(SignerRole).min(1),
    notBefore: isoTime,
    notAfter: isoTime,
    revoked: z.boolean().default(false),
  })
  .strict();
export type TrustedKey = z.infer<typeof TrustedKey>;

export const TrustStore = z
  .object({
    schema: z.literal("tdp-truststore/0.1"),
    keys: z.array(TrustedKey).max(1000),
  })
  .strict();
export type TrustStore = z.infer<typeof TrustStore>;
