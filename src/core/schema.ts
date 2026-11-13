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

export const ManifestPackage = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1).max(200),
    partNumber,
    revision,
    created: isoTime,
    expires: isoTime.optional(),
    distribution: z.string().max(500).optional(),
  })
  .strict();
export type ManifestPackage = z.infer<typeof ManifestPackage>;

const manifestBody = {
  package: ManifestPackage,
  files: z.array(ManifestFile).min(1).max(10_000),
  bom: z.array(BomItem).max(100_000).default([]),
};

/** The original format. Still accepted exactly as before: no engineering model, no reinterpretation. */
export const ManifestV01 = z.object({ schema: z.literal("tdp-manifest/0.1"), ...manifestBody }).strict();

/**
 * 0.2 adds one thing: a pointer to the canonical engineering model (engineering.ts), which is an
 * ordinary manifest-listed file and so covered by the same signatures. Everything else is unchanged.
 */
export const ManifestV02 = z
  .object({
    schema: z.literal("tdp-manifest/0.2"),
    ...manifestBody,
    engineering: z.object({ path: z.string().min(1).max(255), schema: z.literal("tdp-engineering/0.1") }).strict(),
  })
  .strict();

/** Every manifest version this viewer understands. An unknown `schema` is rejected, never guessed at. */
export const Manifest = z.discriminatedUnion("schema", [ManifestV01, ManifestV02]);
export type Manifest = z.infer<typeof Manifest>;
export const MANIFEST_SCHEMAS = ["tdp-manifest/0.1", "tdp-manifest/0.2"] as const;

/**
 * Package-signing roles: what a signature on the manifest attests. These are cryptographic roles
 * only. Engineering workflow roles (requirement owner, planner, operator, inspector, ...) are a
 * separate vocabulary granted by the workflow authority configuration (authority.ts), and neither
 * kind of role is a manufacturing permission or proof of source-system release.
 */
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

/**
 * The organization a key holder acts for. It's vouched for by whoever issues the trust store
 * (the organization root, when the store is signed), never by a package or a record.
 */
export const Organization = z
  .object({
    name: z.string().min(1).max(200),
    /** CAGE code, where one applies. Identifies the organization; it grants nothing by itself. */
    cage: z.string().regex(/^[A-Z0-9]{5}$/, "5-character CAGE code").optional(),
  })
  .strict();
export type Organization = z.infer<typeof Organization>;

export const TrustedKey = z
  .object({
    keyId: z.string().regex(/^[0-9a-f]{32}$/),
    name: z.string().min(1).max(200),
    organization: Organization.optional(),
    publicKey: z.string().min(1).max(100),
    /**
     * Package-signing roles. May be empty for a key that only signs workflow records: its identity
     * and organization come from here, its workflow roles from the authority configuration.
     */
    roles: z.array(SignerRole).max(8),
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
    /** Set when a root signs the store. Increases with every signed release; see truststore.ts. */
    serial: z.number().int().positive().optional(),
    issuer: z.string().max(200).optional(),
    issued: isoTime.optional(),
    expires: isoTime.optional(),
  })
  .strict();
export type TrustStore = z.infer<typeof TrustStore>;
