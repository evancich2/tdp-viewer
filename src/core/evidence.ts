import { z } from "zod";
import { utf8 } from "./bytes";
import { canonicalSha256 } from "./canonical";
import { DECISION_RULES_ID } from "./inspection";
import type { TrustStore } from "./schema";
import { signWith, type KeyHandle, verifyEd25519 } from "./signing";
import type { ProposalSet, ReconciliationRow } from "./exchange";
import { workflowStatus, type LedgerResult, type WorkflowContext } from "./records";
import type { VerifyResult } from "./verify";

// The evidence bundle: one JSON file a reviewer can check without the tool. Identifiers and digests
// only, plus verification outcomes and stated limitations. It never contains private keys, key
// files, passphrases, printer access codes or API credentials: none of those are inputs here.

export const STANDARD_LIMITATIONS = [
  "Signatures prove which key signed which bytes, not when: record times are the signer's claim. Time is bounded only where a tree head carries an RFC 3161 timestamp from a TSA you trust, and only as 'no later than'.",
  "The record hash chain detects edits, reordering and removal in the middle of a ledger; dropped newest records are detected only against tree heads (or checkpoints) held by someone other than the ledger's holder.",
  "Offline verification can't learn of revocations issued after the loaded trust store and authority configuration; actions that need current revocation status are denied beyond the configuration's offline validity window.",
  "A valid package signature establishes integrity and signer authorization under the trust policy; it does not authorize manufacture or prove source-system release.",
  "Source release evidence from a laboratory fixture authority is not evidence of release in Onshape or Windchill; no live integration with either exists in this increment.",
  "Evidence files are checked by SHA-256 only; their content (a calibration certificate, a photo) is not interpreted.",
];

export interface Demonstration {
  id: string;
  scenario: string;
  expected: string;
  actual: string;
  pass: boolean;
}

export interface EvidenceBundleInput {
  verify: VerifyResult;
  trustStoreSha256: string;
  ledger: LedgerResult;
  ctx: WorkflowContext;
  ledgerSha256: string;
  reconciliation?: { proposals: ProposalSet; rows?: ReconciliationRow[] };
  demonstrations?: Demonstration[];
  performance?: { metric: string; value: number; unit: string; note: string }[];
  limitations?: string[];
  now?: Date;
}

export function buildEvidenceBundle(i: EvidenceBundleInput) {
  const m = i.verify.manifest!;
  const model = i.ctx.baseline.model;
  const statuses = workflowStatus(i.ledger, i.ctx);
  const ev = i.ctx.evidence;
  const recordsOut = i.ledger.records.map((v) => ({
    seq: v.record.seq,
    recordId: v.record.recordId,
    sha256: v.sha256,
    action: v.record.action,
    kind: v.record.data.kind,
    outcome: v.record.outcome,
    at: v.record.at,
    actor: { keyId: v.key.keyId, name: v.key.name, organization: v.record.actor.organization, role: v.record.actor.role, authorizedVia: v.via },
    unit: v.record.unit ?? null,
    evidence: v.record.evidence.map((e) => ({ id: e.id, tag: e.tag, sha256: e.sha256, synthetic: e.synthetic, hashVerified: !!ev?.has(e.sha256) })),
    held: v.held,
  }));
  const plan = [...i.ledger.records].reverse().find((v) => v.record.data.kind === "plan");
  const inspection = [...i.ledger.records].reverse().find((v) => v.record.data.kind === "inspection");
  const traceability = model.requirements.map((r) => ({
    requirement: `${r.id} v${r.version}`,
    verification: r.verification,
    characteristics: r.characteristics.map((cid) => {
      const c = model.characteristics.find((x) => x.id === cid)!;
      const res = inspection?.inspection?.results.find((x) => x.characteristic === cid);
      return {
        id: cid,
        limits: `${c.lower} ≤ ${c.name} ≤ ${c.upper} ${c.unit} (nominal ${c.nominal}, ${c.decisionRule})`,
        planned: plan?.record.data.kind === "plan" ? plan.record.data.inspectionPlan.some((p) => p.characteristic === cid) : false,
        result: res?.result ?? "not measured",
        basis: res?.reasons ?? [],
      };
    }),
  }));
  return {
    schema: "tdp-evidence-bundle/0.1",
    generatedAt: (i.now ?? new Date()).toISOString(),
    generator: "tdp-viewer 0.1.0",
    synthetic: model.synthetic,
    label: model.label,
    status: {
      packageIntegrity: i.verify.verdict === "trusted" ? "Package integrity verified" : "Package rejected",
      baseline: statuses.baseline.text,
      sourceRelease: statuses.sourceRelease.text,
      operation: statuses.operation.text,
      inspection: statuses.inspection.text,
      disposition: statuses.disposition.text,
    },
    package: {
      id: m.package.id, schema: m.schema, partNumber: m.package.partNumber, revision: m.package.revision, manifestSha256: i.verify.manifestSha256,
      verdict: i.verify.verdict, checks: i.verify.checks,
    },
    baseline: { id: model.baseline.id, item: model.baseline.item, effectivity: model.baseline.effectivity, supersedes: model.baseline.supersedes ?? null, sources: model.sources },
    configuration: {
      trustStoreSha256: i.trustStoreSha256,
      authority: { id: i.ctx.authority.config.id, serial: i.ctx.authority.config.serial, sha256: i.ctx.authority.sha256, fixture: i.ctx.authority.config.fixture, label: i.ctx.authority.config.label, signedBy: i.ctx.authority.signedBy?.name ?? null, issued: i.ctx.authority.config.issued, offlineValidityHours: i.ctx.authority.config.offlineValidityHours },
      process: { id: i.ctx.process.definition.id, version: i.ctx.process.definition.version, sha256: i.ctx.process.sha256 },
      decisionRules: DECISION_RULES_ID,
      evaluatedAt: i.ctx.now.toISOString(),
    },
    ledger: { sha256: i.ledgerSha256, instance: i.ledger.instance?.id ?? null, verdict: i.ledger.verdict, state: i.ledger.state, records: i.ledger.records.length, head: i.ledger.head ?? null, checks: i.ledger.checks },
    records: recordsOut,
    traceability,
    reconciliation: i.reconciliation
      ? {
          recipe: i.reconciliation.proposals.recipe,
          transactions: i.reconciliation.proposals.transactions.map((t) => ({
            txId: t.txId, contentSha256: t.contentSha256, operation: t.operation, target: t.target, expectedVersion: t.expectedVersion, status: t.status, lossy: t.lossy,
            ack: i.reconciliation!.rows?.find((r) => r.tx.txId === t.txId)?.ack ?? null,
          })),
          excluded: i.reconciliation.proposals.excluded,
        }
      : null,
    demonstrations: i.demonstrations ?? [],
    performance: i.performance ?? [],
    limitations: i.limitations ?? STANDARD_LIMITATIONS,
  };
}
export type EvidenceBundle = ReturnType<typeof buildEvidenceBundle>;

// ---- Signed bundles: a reviewer can check the bundle without the tool's run ----

export const SignedEvidence = z
  .object({
    schema: z.literal("tdp-signed-evidence/0.1"),
    bundle: z.record(z.string(), z.unknown()),
    signature: z.object({ keyId: z.string().regex(/^[0-9a-f]{32}$/), alg: z.literal("Ed25519"), signedAt: z.string().datetime({ offset: true }), sig: z.string().min(1).max(200) }).strict(),
  })
  .strict();
export type SignedEvidence = z.infer<typeof SignedEvidence>;

export const evidenceSigningMessage = (digest: string, signedAt: string) => utf8.encode(`tdp-evidence-signature/0.1\n${signedAt}\n${digest}`);

/** Signs the bundle (as canonical JSON). The signature says who exported it, not that its contents are true. */
export async function signEvidenceBundle(bundle: EvidenceBundle, signer: KeyHandle, now = new Date()): Promise<SignedEvidence> {
  const plain = JSON.parse(JSON.stringify(bundle)) as Record<string, unknown>;
  const signedAt = now.toISOString();
  const sig = await signWith(signer, evidenceSigningMessage(await canonicalSha256(plain), signedAt));
  return { schema: "tdp-signed-evidence/0.1", bundle: plain, signature: { keyId: signer.keyId, alg: "Ed25519", signedAt, sig } };
}

export async function verifySignedEvidence(raw: unknown, trustStore: TrustStore): Promise<{ signer?: string; sha256?: string; problem?: string }> {
  const parsed = SignedEvidence.safeParse(raw);
  if (!parsed.success) return { problem: `not a signed evidence bundle: ${parsed.error.message}` };
  const { bundle, signature } = parsed.data;
  const key = trustStore.keys.find((k) => k.keyId === signature.keyId);
  if (!key) return { problem: "signer is not in the trust store" };
  if (key.revoked) return { problem: `${key.name}'s key is revoked` };
  const t = Date.parse(signature.signedAt);
  if (t < Date.parse(key.notBefore) || t > Date.parse(key.notAfter)) return { problem: `${key.name}'s key was not valid at ${signature.signedAt}` };
  const digest = await canonicalSha256(bundle);
  if (!(await verifyEd25519(key.publicKey, signature.sig, evidenceSigningMessage(digest, signature.signedAt)))) return { problem: "signature does not verify (bundle altered?)" };
  return { signer: key.name, sha256: digest };
}
