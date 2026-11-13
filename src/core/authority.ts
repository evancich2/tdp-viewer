import { z } from "zod";
import { fromBase64, sha256Hex, toBase64, utf8 } from "./bytes";
import { Organization, type TrustStore, type TrustedKey } from "./schema";
import { signEd25519, verifyEd25519 } from "./signing";
import type { Anchors, RootKey } from "./truststore";

// Workflow authority: which keys may act in which engineering workflow roles, for which
// organizations and processes, and which source systems are authoritative for release. This is
// operator-trusted configuration, like the trust store: it never comes from a package or a record.
//
// The four kinds of authority stay separate:
//   1. package-signing roles (author, checker, approver, release)  → trust store `roles`
//   2. engineering workflow roles (planner, operator, inspector, …) → `grants` here
//   3. organization membership                                      → trust store `organization`, recognised here
//   4. source-system release authority                              → `sources` here (who is authoritative, not a live check)
// A valid package signature proves integrity and signer authorization under the trust policy. It
// grants no workflow role, no manufacturing permission, and is not evidence of source-system release.

const keyId = z.string().regex(/^[0-9a-f]{32}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const isoTime = z.string().datetime({ offset: true });
const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const WorkflowRole = z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/, "workflow role: lowercase-with-dashes");

export const AuthorityConfig = z
  .object({
    schema: z.literal("tdp-authority/0.1"),
    id,
    serial: z.number().int().positive(),
    issuer: z.string().min(1).max(200),
    issued: isoTime,
    expires: isoTime,
    /** True for the local laboratory authority fixture. Shown wherever its decisions are shown. */
    fixture: z.boolean(),
    label: z.string().min(1).max(500),
    /**
     * How long after `issued` this configuration may be relied on for actions that need current
     * revocation status. Offline, nothing newer can be learned; past this window those actions are
     * denied until a fresh configuration is loaded.
     */
    offlineValidityHours: z.number().int().min(1).max(24 * 90),
    organizations: z.array(Organization).min(1).max(100),
    sources: z
      .array(
        z
          .object({
            id,
            system: z.enum(["onshape", "windchill", "lab-fixture"]),
            label: z.string().min(1).max(200),
            /** Item ids this source is the release authority for. */
            authoritativeFor: z.array(id).min(1).max(1000),
            /** Nothing in this increment talks to a live system. */
            integration: z.enum(["none", "file-exchange"]),
            /** Release states this source uses to mean "released for build". */
            releasedStates: z.array(z.string().min(1).max(64)).min(1).max(8),
          })
          .strict(),
      )
      .max(20),
    /** Process definitions this authority allows, pinned by digest of the exact file bytes. */
    processes: z.array(z.object({ id, version: z.number().int().positive(), sha256 }).strict()).max(50),
    grants: z
      .array(
        z
          .object({
            keyId,
            organization: z.string().min(1).max(200),
            roles: z.array(WorkflowRole).min(1).max(16),
            processes: z.array(id).min(1).max(50),
            /** May issue delegation records for these roles to other keys (one level only). */
            mayDelegate: z.boolean(),
            notBefore: isoTime,
            notAfter: isoTime,
          })
          .strict(),
      )
      .max(1000),
    /** Workflow-level revocation, on top of the trust store's. */
    revokedKeys: z.array(z.object({ keyId, reason: z.string().min(1).max(500) }).strict()).max(1000),
  })
  .strict();
export type AuthorityConfig = z.infer<typeof AuthorityConfig>;

// ---- Signed configuration envelope (also usable for process definitions) ----

export const SignedConfig = z
  .object({
    schema: z.literal("tdp-signed-config/0.1"),
    payloadSchema: z.string().min(1).max(64),
    payload: z.string().min(1).max(4_000_000),
    signatures: z.array(z.object({ keyId, alg: z.literal("Ed25519"), signedAt: isoTime, sig: z.string().min(1).max(200) }).strict()).min(1).max(8),
  })
  .strict();
export type SignedConfig = z.infer<typeof SignedConfig>;

export const configSigningMessage = (payloadSchema: string, payloadSha256: string, signedAt: string) =>
  utf8.encode(`tdp-config-signature/0.1\n${payloadSchema}\n${signedAt}\n${payloadSha256}`);

export async function signConfig(payloadSchema: string, payloadBytes: Uint8Array, root: { keyId: string; privateKey: CryptoKey }, now = new Date()): Promise<SignedConfig> {
  const signedAt = now.toISOString();
  const sig = await signEd25519(root.privateKey, configSigningMessage(payloadSchema, await sha256Hex(payloadBytes), signedAt));
  return { schema: "tdp-signed-config/0.1", payloadSchema, payload: toBase64(payloadBytes), signatures: [{ keyId: root.keyId, alg: "Ed25519", signedAt, sig }] };
}

/** Opens a signed envelope against pinned roots; returns the exact signed bytes. */
export async function openSignedConfig(raw: unknown, expectSchema: string, anchors: Anchors): Promise<{ bytes: Uint8Array; signedBy: RootKey }> {
  const env = SignedConfig.parse(raw);
  if (env.payloadSchema !== expectSchema) throw new Error(`signed config holds ${env.payloadSchema}, expected ${expectSchema}`);
  const bytes = fromBase64(env.payload);
  const digest = await sha256Hex(bytes);
  for (const s of env.signatures) {
    const root = anchors.roots.find((r) => r.keyId === s.keyId);
    if (root && (await verifyEd25519(root.publicKey, s.sig, configSigningMessage(env.payloadSchema, digest, s.signedAt)))) return { bytes, signedBy: root };
  }
  throw new Error(`no valid signature from a pinned root on this ${expectSchema}`);
}

export interface LoadedAuthority {
  config: AuthorityConfig;
  /** SHA-256 of the exact configuration bytes, for evidence. */
  sha256: string;
  signedBy?: RootKey;
}

/**
 * Loads an authority configuration, signed or plain, with the same rules as trust stores: once a
 * root is pinned only root-signed configurations are accepted, and a serial lower than one already
 * seen is refused as a rollback. Expiry is checked by the workflow engine against its clock.
 */
export async function loadAuthority(json: string, opts: { anchors?: Anchors; seenSerial?: number } = {}): Promise<LoadedAuthority> {
  const raw = JSON.parse(json) as { schema?: unknown };
  let bytes: Uint8Array;
  let signedBy: RootKey | undefined;
  if (raw.schema === "tdp-signed-config/0.1") {
    if (!opts.anchors) throw new Error("this authority configuration is signed; pin the organization's root key to check it");
    ({ bytes, signedBy } = await openSignedConfig(raw, "tdp-authority/0.1", opts.anchors));
  } else {
    if (opts.anchors) throw new Error("this authority configuration isn't signed, and you've pinned a root key: only signed configurations are accepted");
    bytes = utf8.encode(json);
  }
  const config = AuthorityConfig.parse(JSON.parse(utf8.decode(bytes)));
  if (opts.seenSerial && config.serial < opts.seenSerial)
    throw new Error(`authority serial ${config.serial} is older than serial ${opts.seenSerial} already seen (possible rollback)`);
  for (const g of config.grants)
    if (!config.organizations.some((o) => o.name === g.organization)) throw new Error(`grant for ${g.keyId} names unrecognised organization ${g.organization}`);
  return { config, sha256: await sha256Hex(bytes), signedBy };
}

// ---- Resolving an actor's authority ----

export interface Delegation {
  /** Record id of the delegation record, for the explanation. */
  recordId: string;
  issuer: string;
  subject: string;
  organization: string;
  role: string;
  processes: string[];
  notBefore: string;
  notAfter: string;
}

export interface AuthorityContext {
  authority: AuthorityConfig;
  trustStore: TrustStore;
  now: Date;
  skewMs: number;
}

/** Identity: the key is trusted, unrevoked, valid at `at` and now, and belongs to the organization it asserts. */
export function checkIdentity(ctx: AuthorityContext, keyId: string, organization: string, at: string): { key?: TrustedKey; problem?: string } {
  const key = ctx.trustStore.keys.find((k) => k.keyId === keyId);
  if (!key) return { problem: `key ${keyId} is not in the trust store` };
  if (key.revoked) return { key, problem: `${key.name}'s key is revoked in the trust store` };
  const revoked = ctx.authority.revokedKeys.find((r) => r.keyId === keyId);
  // Revocation denies every record by the key, including ones dated earlier: a signature doesn't prove when it was made.
  if (revoked) return { key, problem: `${key.name}'s key is revoked by the authority configuration (${revoked.reason})` };
  const t = Date.parse(at);
  const from = Date.parse(key.notBefore) - ctx.skewMs;
  const to = Date.parse(key.notAfter) + ctx.skewMs;
  if (t > ctx.now.getTime() + ctx.skewMs) return { key, problem: "record time is in the future" };
  if (t < from || t > to) return { key, problem: `${key.name}'s key was not valid at ${at}` };
  if (ctx.now.getTime() < from || ctx.now.getTime() > to) return { key, problem: `${key.name}'s key is not currently valid` };
  if (!key.organization) return { key, problem: `${key.name}'s key has no organization in the trust store` };
  if (key.organization.name !== organization) return { key, problem: `${key.name} asserts organization ${organization}, but the trust store binds the key to ${key.organization.name}` };
  if (!ctx.authority.organizations.some((o) => o.name === organization)) return { key, problem: `organization ${organization} is not recognised by authority ${ctx.authority.id}` };
  return { key };
}

const within = (at: string, from: string, to: string, skew: number) => {
  const t = Date.parse(at);
  return t >= Date.parse(from) - skew && t <= Date.parse(to) + skew;
};

/**
 * Whether `keyId` may act as `role` for `organization` in process `processId` at time `at`: from a
 * grant in the authority configuration, or from a delegation issued earlier by a key whose own grant
 * allows delegating that role. A delegation never authorizes its own issuer and can't be re-delegated.
 */
export function resolveRole(
  ctx: AuthorityContext,
  keyId: string,
  organization: string,
  role: string,
  processId: string,
  at: string,
  delegations: readonly Delegation[],
): { via?: string; problem?: string } {
  const grant = ctx.authority.grants.find(
    (g) => g.keyId === keyId && g.organization === organization && g.roles.includes(role) && g.processes.includes(processId),
  );
  if (grant) {
    if (!within(at, grant.notBefore, grant.notAfter, ctx.skewMs)) return { problem: `grant of ${role} to this key is not valid at ${at}` };
    return { via: `grant in ${ctx.authority.id} serial ${ctx.authority.serial}` };
  }
  for (const d of delegations) {
    if (d.subject !== keyId || d.role !== role || d.organization !== organization || !d.processes.includes(processId)) continue;
    if (!within(at, d.notBefore, d.notAfter, ctx.skewMs)) continue;
    const issuerOk = delegationIssuerProblem(ctx, d.issuer, organization, role, processId, at);
    if (issuerOk) continue;
    return { via: `delegation ${d.recordId} from ${d.issuer}` };
  }
  return { problem: `no grant or valid delegation gives this key the ${role} role for ${organization} in ${processId}` };
}

/** A delegation's issuer must hold the role directly, with `mayDelegate`, from configuration. */
export function delegationIssuerProblem(ctx: AuthorityContext, issuer: string, organization: string, role: string, processId: string, at: string): string | null {
  const g = ctx.authority.grants.find(
    (x) => x.keyId === issuer && x.organization === organization && x.roles.includes(role) && x.processes.includes(processId),
  );
  if (!g) return `issuer holds no configured grant of ${role} for ${organization} in ${processId}`;
  if (!g.mayDelegate) return `issuer's grant of ${role} does not allow delegation`;
  if (!within(at, g.notBefore, g.notAfter, ctx.skewMs)) return `issuer's grant is not valid at ${at}`;
  return null;
}

/** Freshness: may this configuration still be relied on for revocation-sensitive actions at `at`? */
export function freshnessProblem(authority: AuthorityConfig, at: Date): string | null {
  const limit = Date.parse(authority.issued) + authority.offlineValidityHours * 3_600_000;
  if (at.getTime() <= limit) return null;
  return `needs current revocation status, which can't be established offline: authority ${authority.id} serial ${authority.serial} was issued ${authority.issued}, beyond its ${authority.offlineValidityHours} h offline validity window; load a freshly issued configuration`;
}
