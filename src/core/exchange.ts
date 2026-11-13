import { z } from "zod";
import { canonicalSha256 } from "./canonical";
import type { AuthorityConfig } from "./authority";
import { utf8 } from "./bytes";
import type { TrustStore } from "./schema";
import { signEd25519, verifyEd25519 } from "./signing";
import { ArtifactClass, RelationshipType, SourceSystem, itemKey, type EngineeringModel } from "./engineering";
import { RecordKind } from "./process";
import type { BaselineContext, LedgerResult, VerifiedRecord } from "./records";

// The exchange boundary with source systems (Onshape, Windchill, a lab fixture). A TDP is data, not
// an executable: nothing here runs code from a package. Downstream facts leave as *proposed*
// transactions in a file; the source system (here, a local fixture adapter) answers with
// acknowledgements in a file. Neither ever rewrites a released baseline: a change the source
// approves becomes a new, separately published baseline. No live Onshape or Windchill connectivity
// exists in this increment, and nothing claims it does.

const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const isoTime = z.string().datetime({ offset: true });
const objectType = z.string().min(1).max(64).regex(/^[A-Z][A-Za-z0-9]*$/);
const Primitive = z.union([z.string().max(4000), z.number(), z.boolean(), z.null()]);

export const PublishingRecipe = z
  .object({
    schema: z.literal("tdp-recipe/0.1"),
    id,
    version: z.number().int().positive(),
    label: z.string().min(1).max(500),
    /** The one baseline this recipe publishes from. */
    baseline: z.object({ baselineId: id, manifestSha256: sha256 }).strict(),
    includeArtifactClasses: z.array(ArtifactClass).min(1),
    requiredRelationships: z.array(RelationshipType),
    permittedRecordKinds: z.array(RecordKind),
    target: z.object({ system: SourceSystem, adapter: z.literal("local-fixture") }).strict(),
    mappings: z
      .array(
        z
          .object({
            recordKind: RecordKind,
            objectType,
            /** One object per physical unit (updated as the unit progresses), or one per record. */
            key: z.enum(["unit", "record"]),
            /** Target attribute → source path (record.*, data.*, unit.*, item.*, baseline.*, actor.*). */
            fields: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]*$/), z.string().min(1).max(200)),
            /** Source content this mapping can't carry. Listed, never dropped silently. */
            lossy: z.array(z.object({ field: z.string().min(1).max(200), reason: z.string().min(1).max(300) }).strict()),
            /** The recipe owner's explicit acceptance of that loss. Without it the transaction is held. */
            acceptLoss: z.boolean(),
            /** A target object whose approval would change the engineering definition. */
            changesDefinition: z.boolean(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type PublishingRecipe = z.infer<typeof PublishingRecipe>;

export const Transaction = z
  .object({
    txId: z.string().regex(/^tx-[0-9a-f]{32}$/),
    /** Digest of everything below except txId and contentSha256. */
    contentSha256: sha256,
    operation: z.enum(["create", "update"]),
    target: z.object({ system: SourceSystem, objectType, objectId: z.string().min(1).max(200) }).strict(),
    /** Version the proposer expects the target to be at; null for a create. */
    expectedVersion: z.number().int().positive().nullable(),
    attributes: z.record(z.string(), Primitive),
    source: z.object({ recordId: z.string().uuid(), recordSha256: sha256, kind: RecordKind }).strict(),
    lossy: z.array(z.object({ field: z.string(), reason: z.string() }).strict()),
    status: z.enum(["proposed", "held-lossy", "unsupported"]),
    changesDefinition: z.boolean(),
  })
  .strict();
export type Transaction = z.infer<typeof Transaction>;

export const ProposalSet = z
  .object({
    schema: z.literal("tdp-sync-proposals/0.1"),
    recipe: z.object({ id, version: z.number().int().positive() }).strict(),
    baseline: z.object({ packageId: z.string().uuid(), manifestSha256: sha256, baselineId: id }).strict(),
    ledger: z.object({ instance: z.string().uuid(), count: z.number().int().nonnegative(), head: sha256 }).strict(),
    generatedAt: isoTime,
    transactions: z.array(Transaction).max(10_000),
    excluded: z.array(z.object({ recordId: z.string().uuid(), kind: z.string(), reason: z.string() }).strict()),
  })
  .strict();
export type ProposalSet = z.infer<typeof ProposalSet>;

export const AckStatus = z.enum(["accepted", "no-change", "conflict", "unsupported", "rejected", "duplicate"]);
export type AckStatus = z.infer<typeof AckStatus>;
export const Acknowledgement = z
  .object({
    txId: z.string().regex(/^tx-[0-9a-f]{32}$/),
    contentSha256: sha256,
    status: AckStatus,
    /** For a duplicate: the status the first delivery got. */
    originalStatus: AckStatus.optional(),
    objectType: z.string(),
    objectId: z.string(),
    sourceVersion: z.number().int().positive().nullable(),
    reason: z.string().max(1000),
    requiresNewBaseline: z.boolean(),
  })
  .strict();
export type Acknowledgement = z.infer<typeof Acknowledgement>;

export const AckSet = z
  .object({
    schema: z.literal("tdp-sync-acks/0.1"),
    adapter: z.object({ system: SourceSystem, label: z.string(), fixture: z.boolean() }).strict(),
    proposalSetSha256: sha256,
    acknowledgedAt: isoTime,
    acks: z.array(Acknowledgement),
    /** Signature by a key the authority configuration names for this source system. */
    signature: z.object({ keyId: z.string().regex(/^[0-9a-f]{32}$/), alg: z.literal("Ed25519"), signedAt: isoTime, sig: z.string().min(1).max(200) }).strict().optional(),
  })
  .strict();

export const ackSigningMessage = (digest: string, signedAt: string) => utf8.encode(`tdp-sync-acks-signature/0.1\n${signedAt}\n${digest}`);
const unsignedDigest = ({ signature: _s, ...rest }: AckSet) => canonicalSha256(rest);

/** Checks an acknowledgement set's signature against the authority's keys for its source system. */
export async function verifyAckSignature(acks: AckSet, trustStore: TrustStore, authority: AuthorityConfig, now = new Date()): Promise<{ signer?: string; problem?: string }> {
  if (!acks.signature) return { problem: "acknowledgements are unsigned" };
  const allowed = authority.sources.filter((s) => s.system === acks.adapter.system).flatMap((s) => s.acknowledgementKeys ?? []);
  if (!allowed.includes(acks.signature.keyId)) return { problem: `key ${acks.signature.keyId} is not configured to acknowledge for ${acks.adapter.system}` };
  const key = trustStore.keys.find((k) => k.keyId === acks.signature!.keyId);
  if (!key) return { problem: "acknowledgement key is not in the trust store" };
  if (key.revoked || authority.revokedKeys.some((r) => r.keyId === key.keyId)) return { problem: `${key.name}'s key is revoked` };
  if (now.getTime() < Date.parse(key.notBefore) || now.getTime() > Date.parse(key.notAfter)) return { problem: `${key.name}'s key is not currently valid` };
  const ok = await verifyEd25519(key.publicKey, acks.signature.sig, ackSigningMessage(await unsignedDigest(acks), acks.signature.signedAt));
  return ok ? { signer: key.name } : { problem: "acknowledgement signature does not verify" };
}
export type AckSet = z.infer<typeof AckSet>;

/** Problems with the recipe against the baseline it claims to publish. */
export function checkRecipe(recipe: PublishingRecipe, baseline: BaselineContext): string[] {
  const m = baseline.model;
  const problems: string[] = [];
  if (recipe.baseline.baselineId !== m.baseline.id || recipe.baseline.manifestSha256 !== baseline.manifestSha256)
    problems.push(`recipe ${recipe.id} selects baseline ${recipe.baseline.baselineId} (${recipe.baseline.manifestSha256.slice(0, 12)}…), not ${m.baseline.id} (${baseline.manifestSha256.slice(0, 12)}…)`);
  for (const c of recipe.includeArtifactClasses) if (!m.artifacts.some((a) => a.class === c)) problems.push(`baseline has no ${c} artifact`);
  for (const r of recipe.requiredRelationships) if (!m.relationships.some((x) => x.type === r)) problems.push(`baseline has no ${r} relationship`);
  for (const map of recipe.mappings) if (!recipe.permittedRecordKinds.includes(map.recordKind)) problems.push(`mapping for ${map.recordKind}, which the recipe doesn't permit`);
  return problems;
}

function resolvePath(v: VerifiedRecord, path: string): z.infer<typeof Primitive> {
  const r = v.record;
  const roots: Record<string, unknown> = { record: r, data: r.data, unit: r.unit ?? {}, item: r.item, baseline: r.baseline, actor: { ...r.actor, name: v.key.name } };
  const [head, ...rest] = path.split(".");
  let cur: unknown = roots[head!];
  for (const p of rest) cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[p] : undefined;
  if (cur === undefined) return null;
  if (cur === null || typeof cur === "string" || typeof cur === "number" || typeof cur === "boolean") return cur;
  return JSON.stringify(cur);
}

export interface AdapterDescriptor {
  system: z.infer<typeof SourceSystem>;
  label: string;
  fixture: boolean;
  objectTypes: string[];
}

/** Turns a verified ledger into proposed transactions under a recipe. Deterministic for the same inputs. */
export async function buildProposals(
  recipe: PublishingRecipe,
  baseline: BaselineContext,
  ledger: LedgerResult,
  target: AdapterDescriptor,
  opts: { now?: Date; knownVersions?: Record<string, number> } = {},
): Promise<ProposalSet> {
  if (ledger.verdict === "rejected" || !ledger.instance) throw new Error("proposals are built only from a ledger that verifies");
  const problems = checkRecipe(recipe, baseline);
  if (problems.length) throw new Error(`recipe doesn't fit this baseline: ${problems.join("; ")}`);
  const versions: Record<string, number> = { ...(opts.knownVersions ?? {}) };
  const transactions: Transaction[] = [];
  const excluded: ProposalSet["excluded"] = [];
  for (const v of ledger.records) {
    const r = v.record;
    if (r.data.kind === "delegation") { excluded.push({ recordId: r.recordId, kind: r.data.kind, reason: "authority records are not synchronized" }); continue; }
    if (!recipe.permittedRecordKinds.includes(r.data.kind)) { excluded.push({ recordId: r.recordId, kind: r.data.kind, reason: "record kind not permitted by recipe" }); continue; }
    const maps = recipe.mappings.filter((m) => m.recordKind === r.data.kind);
    if (!maps.length) { excluded.push({ recordId: r.recordId, kind: r.data.kind, reason: "no mapping for this record kind (unsupported)" }); continue; }
    for (const map of maps) {
      const unit = r.unit?.serial ?? r.unit?.lot;
      if (map.key === "unit" && !unit) { excluded.push({ recordId: r.recordId, kind: r.data.kind, reason: `${map.objectType} is keyed by unit, and this record has none` }); continue; }
      const objectId = map.key === "unit" ? `${r.item.itemId}:${unit}` : r.recordId;
      const vkey = `${map.objectType}/${objectId}`;
      const supported = target.objectTypes.includes(map.objectType);
      const lossyHeld = map.lossy.length > 0 && !map.acceptLoss;
      const counts = supported && !lossyHeld;
      const known = versions[vkey];
      const body = {
        operation: known ? ("update" as const) : ("create" as const),
        target: { system: recipe.target.system, objectType: map.objectType, objectId },
        expectedVersion: known ?? null,
        attributes: Object.fromEntries(Object.entries(map.fields).map(([k, p]) => [k, resolvePath(v, p)])),
        source: { recordId: r.recordId, recordSha256: v.sha256, kind: r.data.kind },
        lossy: map.lossy,
        status: !supported ? ("unsupported" as const) : lossyHeld ? ("held-lossy" as const) : ("proposed" as const),
        changesDefinition: map.changesDefinition,
      };
      if (counts) versions[vkey] = (known ?? 0) + 1;
      const txId = `tx-${(await canonicalSha256({ recipe: recipe.id, recipeVersion: recipe.version, record: v.sha256, objectType: map.objectType, objectId })).slice(0, 32)}`;
      transactions.push({ txId, contentSha256: await canonicalSha256(body), ...body });
    }
  }
  return {
    schema: "tdp-sync-proposals/0.1",
    recipe: { id: recipe.id, version: recipe.version },
    baseline: { packageId: baseline.packageId, manifestSha256: baseline.manifestSha256, baselineId: baseline.model.baseline.id },
    ledger: { instance: ledger.instance.id, count: ledger.records.length, head: ledger.head! },
    generatedAt: (opts.now ?? new Date()).toISOString(),
    transactions,
    excluded,
  };
}

export const txContentSha256 = ({ txId: _t, contentSha256: _c, ...body }: Transaction) => canonicalSha256(body);

// ---- Adapter interface ----

export interface PublicationCheck {
  source: string;
  status: "current" | "superseded" | "not-released" | "mismatch" | "unknown";
  message: string;
}

/**
 * A source-system adapter. `checkPublication` compares the source references a baseline declares
 * with what the source currently says (version checks before publishing a TDP from it); `reconcile`
 * applies proposed transactions idempotently and answers with acknowledgements. A production
 * Onshape or Windchill adapter would implement the same interface; none exists yet.
 */
export interface SourceAdapter {
  describe(): AdapterDescriptor;
  checkPublication(model: EngineeringModel): PublicationCheck[];
  reconcile(proposals: ProposalSet, now?: Date): Promise<AckSet>;
}

// ---- Local fixture adapter ----

export const FixtureState = z
  .object({
    schema: z.literal("tdp-fixture-source/0.1"),
    system: SourceSystem,
    label: z.string().min(1).max(200),
    objectTypes: z.array(objectType),
    /** What the fixture "source system" says about each item's released definition. */
    sourceItems: z.record(
      z.string(),
      z.object({ revision: z.string(), releaseState: z.string(), reference: z.record(z.string(), z.string()) }).strict(),
    ),
    objects: z.record(z.string(), z.object({ version: z.number().int().positive(), attributes: z.record(z.string(), Primitive), lastTx: z.string() }).strict()),
    transactions: z.record(z.string(), z.object({ contentSha256: sha256, ack: Acknowledgement }).strict()),
  })
  .strict();
export type FixtureState = z.infer<typeof FixtureState>;

const sameAttributes = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);

/** A stand-in source system kept in a JSON file. Clearly a fixture: it is labeled as one in every acknowledgement. */
export class LocalFixtureAdapter implements SourceAdapter {
  constructor(public state: FixtureState, private signer?: { keyId: string; privateKey: CryptoKey }) {}

  describe(): AdapterDescriptor {
    return { system: this.state.system, label: this.state.label, fixture: true, objectTypes: this.state.objectTypes };
  }

  checkPublication(model: EngineeringModel): PublicationCheck[] {
    return model.items.map((it) => {
      const src = model.sources.find((s) => s.id === it.source);
      const label = `${itemKey(it)} (${src?.id ?? "no source"})`;
      const cur = this.state.sourceItems[it.itemId];
      if (!src || !cur) return { source: label, status: "unknown", message: `${label}: not known to ${this.state.label}` };
      const refSame = sameAttributes(src.reference, cur.reference);
      if (cur.revision !== it.revision) return { source: label, status: "superseded", message: `${label}: source is now at revision ${cur.revision}` };
      if (!refSame) return { source: label, status: "mismatch", message: `${label}: source reference differs from the baseline's declaration` };
      if (cur.releaseState !== src.declaredReleaseState) return { source: label, status: "not-released", message: `${label}: source state is ${cur.releaseState}, baseline declares ${src.declaredReleaseState}` };
      return { source: label, status: "current", message: `${label}: matches ${this.state.label} (${cur.releaseState})` };
    });
  }

  async reconcile(proposals: ProposalSet, now = new Date()): Promise<AckSet> {
    const set = ProposalSet.parse(proposals);
    const acks: Acknowledgement[] = [];
    // Objects whose earlier transaction in this set wasn't applied: later ones for the same object depend on it.
    const blocked = new Set<string>();
    for (const tx of set.transactions) {
      const base = { txId: tx.txId, contentSha256: tx.contentSha256, objectType: tx.target.objectType, objectId: tx.target.objectId, requiresNewBaseline: false };
      const ack = (status: AckStatus, sourceVersion: number | null, reason: string, extra: Partial<Acknowledgement> = {}): Acknowledgement => ({ ...base, status, sourceVersion, reason, ...extra });
      const seen = this.state.transactions[tx.txId];
      if (seen) {
        acks.push(seen.contentSha256 === tx.contentSha256
          ? ack("duplicate", seen.ack.sourceVersion, "already applied; replay changed nothing", { originalStatus: seen.ack.status, requiresNewBaseline: seen.ack.requiresNewBaseline })
          : ack("rejected", null, "transaction id reused with different content"));
        continue;
      }
      const key = `${tx.target.objectType}/${tx.target.objectId}`;
      const remember = (a: Acknowledgement) => {
        if (a.status !== "accepted" && a.status !== "no-change") blocked.add(key);
        this.state.transactions[tx.txId] = { contentSha256: tx.contentSha256, ack: a };
        acks.push(a);
      };
      if ((await txContentSha256(tx)) !== tx.contentSha256) { acks.push(ack("rejected", null, "content digest does not match the transaction")); continue; }
      if (tx.target.system !== this.state.system) { remember(ack("unsupported", null, `this adapter is ${this.state.system}, not ${tx.target.system}`)); continue; }
      if (tx.status === "unsupported" || !this.state.objectTypes.includes(tx.target.objectType)) { remember(ack("unsupported", null, `${tx.target.objectType} is not a supported object type`)); continue; }
      if (tx.status === "held-lossy") { remember(ack("rejected", null, `lossy mapping (${tx.lossy.map((l) => l.field).join(", ")}) not accepted by the recipe`)); continue; }
      if (blocked.has(key)) { remember(ack("conflict", this.state.objects[key]?.version ?? null, "an earlier transaction for this object in the same set was not applied; resolve it first")); continue; }
      const cur = this.state.objects[key];
      const changeNote = tx.changesDefinition ? " Approval would change the engineering definition: it takes a newly published baseline, and this acknowledgement changes no baseline." : "";
      if (tx.operation === "create") {
        if (cur) {
          if (sameAttributes(cur.attributes, tx.attributes)) remember(ack("no-change", cur.version, "object already exists with identical content"));
          else remember(ack("conflict", cur.version, `object already exists at version ${cur.version} with different content`));
          continue;
        }
        this.state.objects[key] = { version: 1, attributes: tx.attributes, lastTx: tx.txId };
        remember(ack("accepted", 1, `created.${changeNote}`, { requiresNewBaseline: tx.changesDefinition }));
        continue;
      }
      if (!cur) { remember(ack("conflict", null, "update to an object the source doesn't have")); continue; }
      if (cur.version !== tx.expectedVersion) { remember(ack("conflict", cur.version, `expected version ${tx.expectedVersion}, source is at ${cur.version}`)); continue; }
      if (sameAttributes(cur.attributes, tx.attributes)) { remember(ack("no-change", cur.version, "identical to the current version")); continue; }
      this.state.objects[key] = { version: cur.version + 1, attributes: tx.attributes, lastTx: tx.txId };
      remember(ack("accepted", cur.version + 1, `updated.${changeNote}`, { requiresNewBaseline: tx.changesDefinition }));
    }
    const out: AckSet = {
      schema: "tdp-sync-acks/0.1",
      adapter: { system: this.state.system, label: this.state.label, fixture: true },
      proposalSetSha256: await canonicalSha256(set),
      acknowledgedAt: now.toISOString(),
      acks,
    };
    if (!this.signer) return out;
    const signedAt = now.toISOString();
    const sig = await signEd25519(this.signer.privateKey, ackSigningMessage(await unsignedDigest(out), signedAt));
    return { ...out, signature: { keyId: this.signer.keyId, alg: "Ed25519", signedAt, sig } };
  }
}

export interface ReconciliationRow {
  tx: Transaction;
  ack?: Acknowledgement;
  state: "pending" | AckStatus | "held-lossy" | "unsupported";
}

/**
 * Matches acknowledgements to the proposals they answer. Only ever reports: the baseline, its
 * package and the signed ledger are left exactly as they were.
 */
export async function importAcknowledgements(
  proposals: ProposalSet,
  acks: AckSet,
  /** When given, the acknowledgements must be signed by a key the authority names for their source system. */
  trust?: { trustStore: TrustStore; authority: AuthorityConfig; now?: Date },
): Promise<{ rows: ReconciliationRow[]; problems: string[]; versions: Record<string, number>; changeRequests: Transaction[]; signedBy?: string }> {
  const set = ProposalSet.parse(proposals);
  const a = AckSet.parse(acks);
  const problems: string[] = [];
  let signedBy: string | undefined;
  if (trust) {
    const v = await verifyAckSignature(a, trust.trustStore, trust.authority, trust.now);
    if (v.problem) problems.push(v.problem);
    signedBy = v.signer;
  }
  if ((await canonicalSha256(set)) !== a.proposalSetSha256) problems.push("acknowledgements answer a different proposal set");
  const rows: ReconciliationRow[] = set.transactions.map((tx) => {
    const ack = a.acks.find((x) => x.txId === tx.txId);
    if (ack && ack.contentSha256 !== tx.contentSha256) problems.push(`${tx.txId}: acknowledgement is for different content`);
    return { tx, ack, state: ack ? ack.status : tx.status === "proposed" ? "pending" : tx.status };
  });
  for (const x of a.acks) if (!set.transactions.some((t) => t.txId === x.txId)) problems.push(`acknowledgement for unknown transaction ${x.txId}`);
  const versions: Record<string, number> = {};
  for (const r of rows) {
    const ok = r.ack && (r.ack.status === "accepted" || r.ack.status === "no-change" || (r.ack.status === "duplicate" && r.ack.originalStatus !== "rejected"));
    if (ok && r.ack!.sourceVersion) versions[`${r.tx.target.objectType}/${r.tx.target.objectId}`] = r.ack!.sourceVersion;
  }
  const changeRequests = rows.filter((r) => r.ack?.requiresNewBaseline).map((r) => r.tx);
  return { rows: problems.length && trust ? rows.map((r) => ({ tx: r.tx, state: r.tx.status === "proposed" ? ("pending" as const) : r.tx.status })) : rows, problems, versions: problems.length && trust ? {} : versions, changeRequests, signedBy };
}
