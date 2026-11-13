import { z } from "zod";
import { digestEquals, sha256Hex, utf8 } from "./bytes";
import { canonicalSha256 } from "./canonical";
import {
  WorkflowRole,
  checkIdentity,
  delegationIssuerProblem,
  freshnessProblem,
  resolveRole,
  type AuthorityContext,
  type Delegation,
  type LoadedAuthority,
} from "./authority";
import {
  ItemRef,
  characteristicsNeedingGeometryReview,
  itemKey,
  unitInEffectivity,
  type EngineeringModel,
} from "./engineering";
import { DECISION_RULES_ID, Measurement, evaluateInspection, type InspectionEvaluation } from "./inspection";
import type { LoadedProcess, Transition } from "./process";
import type { TrustStore, TrustedKey } from "./schema";
import { signWith, type KeyHandle, verifyEd25519 } from "./signing";
import { SuitabilityInput, evaluateSuitability, type SuitabilityCheck } from "./suitability";
import type { VerifyResult } from "./verify";

// Signed enrichment records: what happened downstream of a released baseline. Records live in a
// ledger file next to the package, never inside it, so the released baseline stays byte-for-byte
// immutable. Each record names the exact baseline (package id + manifest digest + baseline id),
// item revision and physical unit; is signed by a key from the trust store; and is hash-linked to
// the previous record. Whether a record is *allowed* comes only from operator-trusted configuration
// (authority + process definition), never from the record itself.
//
// Limits, stated plainly: a signature proves who signed which bytes, not when. Record times are
// the signer's claim. A hash chain detects edits, reordering and removal in the middle, but not
// truncation of the newest records; that needs tree heads (custody.ts) or a checkpoint held by
// someone else, and RFC 3161 timestamps (tools/timestamp.ts) to bound time.

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const keyId = z.string().regex(/^[0-9a-f]{32}$/);
const isoTime = z.string().datetime({ offset: true });
const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const text = (max: number) => z.string().min(1).max(max);
const recordRef = z.string().uuid();
const settings = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/), z.string().max(200)).refine((s) => Object.keys(s).length <= 64, "at most 64 settings");

// No `.default()` anywhere below: a record's digest is over the JSON as signed, and parsing must not add to it.
export const RecordData = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("requirements-approval"), requirements: z.array(z.object({ id, version: z.number().int().positive() }).strict()).min(1).max(1000) }).strict(),
  z
    .object({
      kind: z.literal("source-release"),
      source: id,
      system: z.enum(["onshape", "windchill", "lab-fixture"]),
      reference: z.record(z.string(), text(200)),
      revision: text(16),
      releaseState: text(64),
      /** How the release evidence was obtained. Nothing here is a live query of the source system. */
      attestation: z.enum(["lab-fixture", "manual-transcription"]),
    })
    .strict(),
  z.object({ kind: z.literal("suitability"), input: SuitabilityInput }).strict(),
  z.object({ kind: z.literal("suitability-review"), suitabilityRecord: recordRef, acceptedGaps: z.array(text(500)).max(100), rationale: text(2000) }).strict(),
  z
    .object({
      kind: z.literal("plan"),
      buildPlanId: id,
      settings,
      inspectionPlan: z.array(z.object({ characteristic: id, method: text(200), instrumentClass: text(200) }).strict()).max(500),
      geometryReview: z.array(z.object({ link: id, resolution: text(500) }).strict()).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("authorization"),
      cipId: id,
      operations: z.array(text(64)).min(1).max(32),
      organizations: z.array(text(200)).min(1).max(20),
      roles: z.array(WorkflowRole).min(1).max(20),
      units: z.object({ serials: z.array(id).max(1000).optional(), lots: z.array(id).max(100).optional() }).strict(),
      notBefore: isoTime,
      notAfter: isoTime,
      policyVersion: z.number().int().positive(),
      /** Optional caps: at most `max` records of `transition` may rely on this CIP, across all units. */
      limits: z.array(z.object({ transition: z.string().min(1).max(64), max: z.number().int().positive() }).strict()).max(20).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("queue-entry"), jobId: id, submittedFile: z.object({ name: text(255), sha256 }).strict(), settings }).strict(),
  z.object({ kind: z.literal("build-start"), jobId: id, resource: id, startedAt: isoTime }).strict(),
  z
    .object({ kind: z.literal("build-complete"), jobId: id, submittedFileSha256: sha256, startedAt: isoTime, completedAt: isoTime, errors: z.array(text(500)).max(100), settings })
    .strict(),
  z.object({ kind: z.literal("inspection"), decisionRules: z.literal(DECISION_RULES_ID), measurements: z.array(Measurement).max(500) }).strict(),
  z.object({ kind: z.literal("nonconformance"), ncrId: id, inspectionRecord: recordRef, characteristics: z.array(id).min(1).max(500), description: text(2000) }).strict(),
  z.object({ kind: z.literal("disposition"), inspectionRecord: recordRef, ncrId: id.optional(), rationale: text(2000) }).strict(),
  z
    .object({ kind: z.literal("closure"), incorporation: z.object({ occurrence: id, parentUnit: id.optional() }).strict().optional(), summary: text(2000) })
    .strict(),
  z
    .object({ kind: z.literal("delegation"), subject: keyId, organization: text(200), role: WorkflowRole, processes: z.array(id).min(1).max(20), notBefore: isoTime, notAfter: isoTime })
    .strict(),
]);
export type RecordData = z.infer<typeof RecordData>;

export const EvidenceRef = z
  .object({ id, tag: text(64), sha256, mediaType: text(100), description: text(500), synthetic: z.boolean() })
  .strict();
export type EvidenceRef = z.infer<typeof EvidenceRef>;

export const PhysicalUnit = z.object({ serial: id.optional(), lot: id.optional() }).strict().refine((u) => u.serial || u.lot, "a unit needs a serial or a lot");

export const WorkflowRecord = z
  .object({
    schema: z.literal("tdp-record/0.1"),
    recordId: z.string().uuid(),
    seq: z.number().int().min(1).max(99_999),
    instance: z.string().uuid(),
    baseline: z.object({ packageId: z.string().uuid(), manifestSha256: sha256, baselineId: id }).strict(),
    item: ItemRef,
    unit: PhysicalUnit.optional(),
    actor: z.object({ keyId, organization: text(200), role: WorkflowRole }).strict(),
    /** A transition id from the process definition, or "delegate". */
    action: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/),
    at: isoTime,
    prev: sha256,
    policy: z.object({ processId: id, processVersion: z.number().int().positive(), processSha256: sha256, authorityId: id, authoritySerial: z.number().int().positive() }).strict(),
    evidence: z.array(EvidenceRef).max(100),
    outcome: text(64),
    reason: text(2000),
    data: RecordData,
  })
  .strict();
export type WorkflowRecord = z.infer<typeof WorkflowRecord>;

export const RecordSignature = z
  .object({ schema: z.literal("tdp-record-signature/0.1"), recordSha256: sha256, keyId, alg: z.literal("Ed25519"), sig: text(200) })
  .strict();
export type RecordSignature = z.infer<typeof RecordSignature>;

export const LedgerInstance = z
  .object({ id: z.string().uuid(), processId: id, packageId: z.string().uuid(), manifestSha256: sha256, baselineId: id, item: ItemRef })
  .strict();
export type LedgerInstance = z.infer<typeof LedgerInstance>;

/** The ledger file. The header is a convenience; every record repeats and signs the binding. */
export const LedgerFile = z
  .object({
    schema: z.literal("tdp-ledger/0.1"),
    instance: LedgerInstance,
    entries: z.array(z.object({ record: z.unknown(), signature: RecordSignature }).strict()).max(10_000),
  })
  .strict();
export type LedgerFile = z.infer<typeof LedgerFile>;

export const recordSigningMessage = (recordSha256: string) => utf8.encode(`tdp-record-signature/0.1\n${recordSha256}`);
export const genesisDigest = (instance: string, manifestSha256: string) => sha256Hex(utf8.encode(`tdp-ledger-genesis/0.1\n${instance}\n${manifestSha256}`));

/** Hash-verified evidence files available to the verifier, by SHA-256. Undefined = none supplied. */
export type EvidenceStore = ReadonlyMap<string, { name: string; size: number }>;

export async function evidenceStoreFrom(files: { name: string; bytes: Uint8Array }[]): Promise<Map<string, { name: string; size: number }>> {
  const m = new Map<string, { name: string; size: number }>();
  for (const f of files) m.set(await sha256Hex(f.bytes), { name: f.name, size: f.bytes.length });
  return m;
}

export interface BaselineContext {
  packageId: string;
  manifestSha256: string;
  created: string;
  model: EngineeringModel;
}

/** The baseline a ledger can bind to: only a trusted `tdp-manifest/0.2` package with no engineering errors. */
export function baselineFrom(result: VerifyResult): BaselineContext {
  if (result.verdict !== "trusted") throw new Error("package is not trusted; records can't be checked against it");
  if (!result.engineering) throw new Error(`${result.manifest?.schema ?? "package"} has no engineering model; workflow records need a tdp-manifest/0.2 package`);
  return { packageId: result.manifest!.package.id, manifestSha256: result.manifestSha256!, created: result.manifest!.package.created, model: result.engineering.model };
}

/** A trusted baseline that names this one in its `supersedes`. */
export interface Successor {
  packageId: string;
  manifestSha256: string;
  baselineId: string;
  created: string;
}

export interface WorkflowContext {
  baseline: BaselineContext;
  authority: LoadedAuthority;
  process: LoadedProcess;
  trustStore: TrustStore;
  now: Date;
  skewMs: number;
  evidence?: EvidenceStore;
  /**
   * Newer baselines the operator knows supersede this one. Once one is known, new work (planning,
   * authorization, queueing, starting builds) under this baseline is refused; units already in
   * progress may still be completed, inspected, dispositioned and closed.
   */
  successors?: Successor[];
}

/** Successors of `baseline` among other verified packages: trusted 0.2 baselines whose `supersedes` names it. */
export function successorsOf(baseline: BaselineContext, others: readonly VerifyResult[]): Successor[] {
  return others.flatMap((r) => {
    const s = r.verdict === "trusted" ? r.engineering?.model.baseline.supersedes : undefined;
    if (!s || s.packageId !== baseline.packageId || s.manifestSha256 !== baseline.manifestSha256 || s.baselineId !== baseline.model.baseline.id) return [];
    return [{ packageId: r.manifest!.package.id, manifestSha256: r.manifestSha256!, baselineId: r.engineering!.model.baseline.id, created: r.manifest!.package.created }];
  });
}

/** Kinds of record that start new work on a baseline, and so stop once it is superseded. */
const NEW_WORK = new Set(["plan", "authorization", "queue-entry", "build-start"]);

export interface VerifiedRecord {
  record: WorkflowRecord;
  sha256: string;
  key: TrustedKey;
  /** How the actor's role was established. */
  via: string;
  /** Evidence not available to hash-check, or other reasons the record is held. */
  held: string[];
  inspection?: InspectionEvaluation;
  suitability?: { outcome: string; checks: SuitabilityCheck[] };
  /** The CIP this record relied on, if its transition needs authorization. */
  authorizedBy?: string;
}

export type LedgerCheckStatus = "pass" | "fail" | "held";
export interface LedgerCheck {
  id: string;
  status: LedgerCheckStatus;
  message: string;
}

export interface LedgerResult {
  /** verified: every record signed, bound and allowed, all evidence hash-checked. held: same, but evidence missing. rejected: something failed. */
  verdict: "verified" | "held" | "rejected";
  checks: LedgerCheck[];
  instance?: LedgerInstance;
  /** Records that verified, in order (up to the first failure). */
  records: VerifiedRecord[];
  /** State of the single unit when the ledger has exactly one; otherwise the instance-level state. */
  state: string;
  /** Instance-level state: from records that name no unit. */
  instanceState: string;
  /** Each physical unit's own state. A ledger may carry one unit or several (a lot, a batch of serials). */
  units: { unit: PhysicalUnitRef; key: string; state: string }[];
  /** Digest of the last verified record (or the genesis digest), for checkpoints. */
  head?: string;
}

export class TransitionDenied extends Error {}

export type PhysicalUnitRef = { serial?: string; lot?: string };
export const unitKey = (u?: PhysicalUnitRef) => (u ? (u.serial ? `serial:${u.serial}` : `lot:${u.lot}`) : "");
export const unitLabel = (u?: PhysicalUnitRef) => (u ? (u.serial ?? `lot ${u.lot}`) : "instance");

/**
 * A unit's track: the instance-level records (no unit) plus that unit's own records. Each unit
 * moves through the unit-level part of the process on its own; instance-level steps (approvals,
 * planning, authorization) are shared by every unit in the ledger.
 */
export function trackOf(history: readonly VerifiedRecord[], unit?: PhysicalUnitRef): VerifiedRecord[] {
  const k = unitKey(unit);
  return history.filter((h) => !h.record.unit || unitKey(h.record.unit) === k);
}

function unitsIn(process: LoadedProcess, history: readonly VerifiedRecord[]): LedgerResult["units"] {
  const seen = new Map<string, PhysicalUnitRef>();
  for (const h of history) if (h.record.unit) seen.set(unitKey(h.record.unit), h.record.unit);
  return [...seen].map(([key, unit]) => ({ unit, key, state: stateOf(process, trackOf(history, unit)) }));
}

const stateOf = (process: LoadedProcess, history: readonly VerifiedRecord[]) => {
  for (let i = history.length - 1; i >= 0; i--) {
    const r = history[i]!.record;
    if (r.action === "delegate") continue;
    const t = process.definition.transitions.find((x) => x.id === r.action);
    if (t) return t.outcomes[r.outcome] ?? process.definition.initial;
  }
  return process.definition.initial;
};
export const currentState = stateOf;

function delegationsIn(history: readonly VerifiedRecord[]): Delegation[] {
  return history.flatMap((h) =>
    h.record.data.kind === "delegation"
      ? [{ recordId: h.record.recordId, issuer: h.record.actor.keyId, subject: h.record.data.subject, organization: h.record.data.organization, role: h.record.data.role, processes: h.record.data.processes, notBefore: h.record.data.notBefore, notAfter: h.record.data.notAfter }]
      : [],
  );
}

const latest = (history: readonly VerifiedRecord[], pred: (r: WorkflowRecord) => boolean) => [...history].reverse().find((h) => pred(h.record));

type Authorization = Extract<RecordData, { kind: "authorization" }>;

/** The newest authorization in the history that covers `operation` for this actor and unit at `at` under the current policy. */
export function findAuthorization(
  history: readonly VerifiedRecord[],
  ctx: WorkflowContext,
  operation: string,
  who: { organization?: string; role?: string; unit?: { serial?: string; lot?: string }; transition?: string },
  at: string,
): { cip?: Authorization & { recordId: string }; problem?: string } {
  const cips = history.filter((h) => h.record.data.kind === "authorization").reverse();
  if (!cips.length) return { problem: `no authorization (CIP) for ${operation} has been issued` };
  const reasons: string[] = [];
  const t = Date.parse(at);
  for (const h of cips) {
    const d = h.record.data as Authorization;
    const label = `CIP ${d.cipId}`;
    if (!d.operations.includes(operation)) { reasons.push(`${label} doesn't cover ${operation}`); continue; }
    if (d.policyVersion !== ctx.process.definition.version) { reasons.push(`${label} was issued under ${ctx.process.definition.id} v${d.policyVersion}; current policy is v${ctx.process.definition.version} (stale)`); continue; }
    if (t < Date.parse(d.notBefore) - ctx.skewMs || t > Date.parse(d.notAfter) + ctx.skewMs) { reasons.push(`${label} is valid ${d.notBefore} to ${d.notAfter}, not at ${at}`); continue; }
    if (who.organization && !d.organizations.includes(who.organization)) { reasons.push(`${label} doesn't cover organization ${who.organization}`); continue; }
    if (who.role && !d.roles.includes(who.role)) { reasons.push(`${label} doesn't cover role ${who.role}`); continue; }
    if (who.unit) {
      const ok = (who.unit.serial && d.units.serials?.includes(who.unit.serial)) || (who.unit.lot && d.units.lots?.includes(who.unit.lot));
      if (!ok) { reasons.push(`${label} doesn't cover unit ${who.unit.serial ?? who.unit.lot}`); continue; }
    }
    const limit = who.transition && d.limits?.find((l) => l.transition === who.transition);
    if (limit) {
      const used = history.filter((x) => x.authorizedBy === d.cipId && x.record.action === limit.transition).length;
      if (used >= limit.max) { reasons.push(`${label} allows at most ${limit.max} ${limit.transition} record(s), and ${used} already used it`); continue; }
    }
    return { cip: { ...d, recordId: h.record.recordId } };
  }
  return { problem: reasons.join("; ") };
}

interface Evaluation {
  fatal: string | null;
  held: string[];
  via?: string;
  inspection?: InspectionEvaluation;
  suitability?: VerifiedRecord["suitability"];
  authorizedBy?: string;
}

/**
 * The gate. Decides whether `rec`, signed by `key`, may follow `history`. Used both before signing
 * (mode "create", which also requires present-tense freshness and evidence) and when verifying a
 * ledger (mode "verify", which judges each record as of its own time and holds on missing evidence).
 */
export function evaluateRecord(history: readonly VerifiedRecord[], rec: WorkflowRecord, ctx: WorkflowContext, mode: "create" | "verify"): Evaluation {
  const held: string[] = [];
  const deny = (why: string): Evaluation => ({ fatal: why, held });
  const { baseline, process, authority } = ctx;
  const def = process.definition;
  const model = baseline.model;
  const actx: AuthorityContext = { authority: authority.config, trustStore: ctx.trustStore, now: ctx.now, skewMs: ctx.skewMs };

  // Baseline, item and policy binding.
  if (rec.baseline.packageId !== baseline.packageId || !digestEquals(rec.baseline.manifestSha256, baseline.manifestSha256) || rec.baseline.baselineId !== model.baseline.id)
    return deny(`wrong baseline: record is bound to package ${rec.baseline.packageId} manifest ${rec.baseline.manifestSha256.slice(0, 12)}… baseline ${rec.baseline.baselineId}, not this baseline ${model.baseline.id} (manifest ${baseline.manifestSha256.slice(0, 12)}…)`);
  const item = model.items.find((i) => i.itemId === rec.item.itemId);
  if (!item) return deny(`item ${rec.item.itemId} is not in baseline ${model.baseline.id}`);
  if (item.revision !== rec.item.revision) return deny(`wrong revision: record is for ${itemKey(rec.item)}, baseline ${model.baseline.id} has ${itemKey(item)}`);
  if (rec.policy.processId !== def.id || rec.policy.processVersion !== def.version || rec.policy.processSha256 !== process.sha256)
    return deny(`record was made under process ${rec.policy.processId} v${rec.policy.processVersion}, but the loaded process is ${def.id} v${def.version} (${process.sha256.slice(0, 12)}…)`);
  if (rec.policy.authorityId !== authority.config.id) return deny(`record names authority ${rec.policy.authorityId}, loaded authority is ${authority.config.id}`);
  if (rec.policy.authoritySerial > authority.config.serial) return deny(`record names authority serial ${rec.policy.authoritySerial}, newer than the loaded serial ${authority.config.serial}`);
  if (Date.parse(rec.at) < Date.parse(baseline.created) - ctx.skewMs) return deny("record is dated before the baseline was created");
  const prevAt = history.at(-1)?.record.at;
  if (prevAt && Date.parse(rec.at) < Date.parse(prevAt)) return deny("record is dated before the record it follows");

  // Identity and role.
  const ident = checkIdentity(actx, rec.actor.keyId, rec.actor.organization, rec.at);
  if (ident.problem) return deny(ident.problem);
  const role = resolveRole(actx, rec.actor.keyId, rec.actor.organization, rec.actor.role, def.id, rec.at, delegationsIn(history));
  if (role.problem) return deny(role.problem);
  if (!def.roles.some((r) => r.id === rec.actor.role)) return deny(`role ${rec.actor.role} is not a role of process ${def.id}`);

  // Unit: within the baseline's effectivity. Several units may share one ledger, each on its own track.
  if (rec.unit) {
    if (!unitInEffectivity(model.baseline.effectivity, rec.unit)) return deny(`unit ${rec.unit.serial ?? rec.unit.lot} is outside baseline effectivity`);
  }

  // Delegation is not a state transition.
  if (rec.action === "delegate") {
    if (rec.data.kind !== "delegation") return deny("a delegate action needs delegation data");
    if (!def.allowDelegation) return deny(`process ${def.id} does not allow delegation`);
    if (rec.outcome !== "issued") return deny("a delegation's outcome is 'issued'");
    const d = rec.data;
    if (d.subject === rec.actor.keyId) return deny("a delegation can't grant authority to its own signer");
    if (d.role !== rec.actor.role || d.organization !== rec.actor.organization) return deny("a key may delegate only the role it holds, within its own organization");
    if (!role.via?.startsWith("grant")) return deny("delegated authority can't be delegated again");
    const issuer = delegationIssuerProblem(actx, rec.actor.keyId, d.organization, d.role, def.id, rec.at);
    if (issuer) return deny(issuer);
    if (!d.processes.every((p) => p === def.id)) return deny("a delegation may only name the current process");
    const subject = ctx.trustStore.keys.find((k) => k.keyId === d.subject);
    if (!subject || subject.organization?.name !== d.organization) return deny(`delegation subject ${d.subject} is not a trusted key of ${d.organization}`);
    if (Date.parse(d.notAfter) <= Date.parse(d.notBefore)) return deny("delegation validity window is empty");
    return { fatal: null, held, via: role.via };
  }

  // Transition.
  const t = def.transitions.find((x) => x.id === rec.action);
  if (!t) return deny(`${rec.action} is not a transition of process ${def.id}`);
  if (t.requires.unit && !rec.unit) return deny(`${t.id} needs a serial or lot`);
  // State, prerequisites and independence are judged on this unit's track (or the instance track).
  const track = rec.unit ? trackOf(history, rec.unit) : history.filter((h) => !h.record.unit);
  const state = stateOf(process, track);
  const unitNote = rec.unit ? ` for ${unitLabel(rec.unit)}` : "";
  if (!t.from.includes(state)) return deny(`${t.id} is not allowed from state ${state}${unitNote} (needs ${t.from.join(" or ")})`);
  if (t.kind !== rec.data.kind) return deny(`${t.id} records ${t.kind} data, not ${rec.data.kind}`);
  if (!(rec.outcome in t.outcomes)) return deny(`${t.id} can't have outcome ${rec.outcome} (allowed: ${Object.keys(t.outcomes).join(", ")})`);
  if (!t.roles.includes(rec.actor.role)) return deny(`${t.id} needs role ${t.roles.join(" or ")}, not ${rec.actor.role}`);
  if (t.organizations && !t.organizations.includes(rec.actor.organization)) return deny(`${t.id} is limited to ${t.organizations.join(", ")}; actor is from ${rec.actor.organization}`);
  for (const need of t.requires.actions) {
    const done = latest(track, (r) => r.action === need.id && (!need.outcomes || need.outcomes.includes(r.outcome)));
    if (!done) return deny(`${t.id} requires ${need.id}${need.outcomes ? ` with outcome ${need.outcomes.join(" or ")}` : ""} first`);
  }
  for (const other of t.distinctActorFrom) {
    const h = latest(track, (r) => r.action === other);
    if (h && h.record.actor.keyId === rec.actor.keyId) return deny(`${t.id} must be signed by someone other than whoever signed ${other}`);
  }
  for (const other of t.distinctOrganizationFrom) {
    const h = latest(track, (r) => r.action === other);
    if (h && h.record.actor.organization === rec.actor.organization) return deny(`${t.id} must come from a different organization than ${other} (both ${rec.actor.organization})`);
  }
  // A known successor baseline stops new work here; units already in progress may finish.
  const successor = ctx.successors?.[0];
  if (successor && NEW_WORK.has(t.kind)) {
    const why = `baseline ${model.baseline.id} is superseded by ${successor.baselineId} (package ${successor.packageId}); new work must follow the new baseline`;
    if (mode === "create") return deny(`${t.id}: ${why}`);
    if (Date.parse(rec.at) > Date.parse(successor.created)) held.push(`${t.id} was recorded after ${why}`);
  }
  if (t.requires.freshAuthority) {
    // Before signing: fresh now. On verification: the record must have been made inside the window of a configuration at least this new.
    const at = mode === "create" ? ctx.now : new Date(Math.max(Date.parse(rec.at), Date.parse(authority.config.issued)));
    const stale = freshnessProblem(authority.config, at);
    if (stale) return deny(`${t.id} ${stale}`);
  }
  let authorizedBy: string | undefined;
  if (t.requires.authorization) {
    const who = { organization: rec.actor.organization, role: rec.actor.role, unit: rec.unit, transition: t.id };
    const a = findAuthorization(history, ctx, t.requires.authorization, who, rec.at);
    if (a.problem) return deny(`${t.id} is not authorized: ${a.problem}`);
    if (mode === "create") {
      const nowA = findAuthorization(history, ctx, t.requires.authorization, who, ctx.now.toISOString());
      if (nowA.problem) return deny(`${t.id} is not authorized now: ${nowA.problem}`);
    }
    if (a.cip && history.find((h) => h.record.recordId === a.cip!.recordId)?.record.actor.keyId === rec.actor.keyId)
      return deny(`${t.id}: the issuer of CIP ${a.cip.cipId} can't also perform the operation it authorizes`);
    authorizedBy = a.cip?.cipId;
  }

  // Evidence: required tags present; every referenced file hash-verified.
  const ids = new Set<string>();
  for (const e of rec.evidence) {
    if (ids.has(e.id)) return deny(`evidence id ${e.id} appears twice`);
    ids.add(e.id);
  }
  for (const tag of t.requires.evidence) if (!rec.evidence.some((e) => e.tag === tag)) return deny(`${t.id} requires evidence tagged ${tag}`);
  for (const e of rec.evidence) {
    if (!ctx.evidence) { held.push(`evidence ${e.id} not hash-checked: no evidence files supplied`); continue; }
    if (!ctx.evidence.has(e.sha256)) {
      if (mode === "create") return deny(`evidence ${e.id} (${e.sha256.slice(0, 12)}…) is not among the supplied files`);
      held.push(`evidence ${e.id} (${e.sha256.slice(0, 12)}…) not available; its hash can't be checked`);
    }
  }

  // What the record says must be consistent with the baseline and with the history.
  const ev = semantics(t, rec, track, history, ctx, mode, held, role.via!);
  return ev.fatal ? ev : { ...ev, authorizedBy };
}

/** `history` is the unit's track; `all` is the whole ledger, for uniqueness checks. */
function semantics(t: Transition, rec: WorkflowRecord, history: readonly VerifiedRecord[], all: readonly VerifiedRecord[], ctx: WorkflowContext, mode: "create" | "verify", held: string[], via: string): Evaluation {
  const deny = (why: string): Evaluation => ({ fatal: `${t.id}: ${why}`, held });
  const ok = (extra: Partial<Evaluation> = {}): Evaluation => ({ fatal: null, held, via, ...extra });
  const model = ctx.baseline.model;
  const forItem = <T extends { item: ItemRef }>(xs: T[]) => xs.filter((x) => x.item.itemId === rec.item.itemId && x.item.revision === rec.item.revision);
  const evidenceIds = new Set(rec.evidence.map((e) => e.id));
  const d = rec.data;

  switch (d.kind) {
    case "requirements-approval": {
      const reqs = model.requirements.filter((r) => itemKey(r.appliesTo) === itemKey(rec.item));
      for (const r of reqs) if (!d.requirements.some((a) => a.id === r.id && a.version === r.version)) return deny(`requirement ${r.id} v${r.version} is not approved`);
      for (const a of d.requirements) if (!reqs.some((r) => r.id === a.id && r.version === a.version)) return deny(`approves ${a.id} v${a.version}, which isn't a requirement of ${itemKey(rec.item)} in this baseline`);
      return ok();
    }
    case "source-release": {
      const item = model.items.find((i) => i.itemId === rec.item.itemId)!;
      const src = model.sources.find((s) => s.id === d.source);
      if (!src) return deny(`source ${d.source} is not declared by the baseline`);
      if (item.source !== src.id) return deny(`the baseline's item ${itemKey(rec.item)} comes from ${item.source ?? "no source"}, not ${src.id}`);
      if (src.system !== d.system) return deny(`source ${src.id} is ${src.system}, record says ${d.system}`);
      const cfg = ctx.authority.config.sources.find((s) => s.system === d.system && s.authoritativeFor.includes(rec.item.itemId));
      if (!cfg) return deny(`no ${d.system} source is configured as release authority for ${rec.item.itemId}`);
      if (d.system === "lab-fixture" ? d.attestation !== "lab-fixture" : d.attestation === "lab-fixture") return deny(`attestation ${d.attestation} doesn't fit a ${d.system} source`);
      if (d.revision !== item.revision) return deny(`source release is for revision ${d.revision}; baseline item is ${item.revision}`);
      if (!cfg.releasedStates.includes(d.releaseState)) return deny(`release state ${d.releaseState} is not one ${cfg.label} treats as released (${cfg.releasedStates.join(", ")})`);
      const same = Object.keys(src.reference).length === Object.keys(d.reference).length && Object.entries(src.reference).every(([k, v]) => d.reference[k] === v);
      if (!same) return deny(`source reference differs from what the baseline declares for ${src.id}`);
      return ok();
    }
    case "suitability": {
      const s = evaluateSuitability(model, rec.item, d.input, rec.at, evidenceIds);
      if (s.outcome !== rec.outcome) return deny(`record concludes ${rec.outcome}, but its own inputs evaluate to ${s.outcome}`);
      return ok({ suitability: s });
    }
    case "suitability-review": {
      const s = latest(history, (r) => r.data.kind === "suitability");
      if (!s || s.record.recordId !== d.suitabilityRecord) return deny("must review the latest suitability record");
      if (s.record.outcome !== "review-required") return deny(`suitability record concluded ${s.record.outcome}; only review-required goes to engineering review`);
      if (s.record.actor.keyId === rec.actor.keyId) return deny("the reviewer must not be the author of the suitability record");
      if (rec.outcome === "accepted") {
        const gaps = s.suitability?.checks.filter((c) => c.result === "gap").map((c) => c.message) ?? [];
        const missing = gaps.filter((g) => !d.acceptedGaps.includes(g));
        if (missing.length) return deny(`acceptance must address every gap explicitly; not addressed: ${missing.join("; ")}`);
      }
      return ok();
    }
    case "plan": {
      const chars = forItem(model.characteristics);
      for (const p of d.inspectionPlan) if (!chars.some((c) => c.id === p.characteristic)) return deny(`plans unknown characteristic ${p.characteristic}`);
      const inspected = chars.filter((c) => model.requirements.find((r) => r.id === c.requirement)?.verification === "inspection");
      for (const c of inspected) if (!d.inspectionPlan.some((p) => p.characteristic === c.id)) return deny(`characteristic ${c.id} needs inspection but isn't planned`);
      const planned = new Set(d.inspectionPlan.map((p) => p.characteristic));
      for (const bad of characteristicsNeedingGeometryReview(model).filter((b) => planned.has(b.id)))
        for (const l of bad.links)
          if (!d.geometryReview.some((g) => g.link === l.id)) return deny(`geometry link ${l.id} of ${bad.id} is ${l.status}; the plan must record a review of it`);
      return ok();
    }
    case "authorization": {
      const def = ctx.process.definition;
      for (const op of d.operations) if (!def.operations.includes(op)) return deny(`operation ${op} is not defined by ${def.id}`);
      if (d.policyVersion !== def.version) return deny(`issued for policy v${d.policyVersion}; current is v${def.version}`);
      if (Date.parse(d.notAfter) <= Date.parse(d.notBefore)) return deny("validity window is empty");
      const units: { serial?: string; lot?: string }[] = [...(d.units.serials ?? []).map((serial) => ({ serial })), ...(d.units.lots ?? []).map((lot) => ({ lot }))];
      if (!units.length) return deny("an authorization must name the serials or lots it applies to");
      for (const u of units) if (!unitInEffectivity(model.baseline.effectivity, u)) return deny(`unit ${u.serial ?? u.lot} is outside baseline effectivity`);
      for (const r of d.roles) if (!def.roles.some((x) => x.id === r)) return deny(`role ${r} is not a role of ${def.id}`);
      for (const l of d.limits ?? []) {
        const lt = def.transitions.find((x) => x.id === l.transition);
        if (!lt?.requires.authorization || !d.operations.includes(lt.requires.authorization)) return deny(`limit on ${l.transition}, which isn't an operation this CIP authorizes`);
      }
      if (all.some((h) => h.record.data.kind === "authorization" && h.record.data.cipId === d.cipId)) return deny(`CIP ${d.cipId} already issued`);
      return ok();
    }
    case "queue-entry": {
      if (!rec.evidence.some((e) => e.sha256 === d.submittedFile.sha256)) return deny("the submitted file must be attached as evidence");
      if (all.some((h) => h.record.data.kind === "queue-entry" && h.record.data.jobId === d.jobId)) return deny(`job ${d.jobId} was already queued`);
      return ok();
    }
    case "build-start": {
      // Only a process that has a queue step requires the started job to be the queued one.
      if (ctx.process.definition.transitions.some((x) => x.kind === "queue-entry")) {
        const q = latest(history, (r) => r.data.kind === "queue-entry");
        if (!q || q.record.data.kind !== "queue-entry" || q.record.data.jobId !== d.jobId) return deny(`job ${d.jobId} is not the queued job`);
      }
      if (all.some((h) => h.record.data.kind === "build-start" && h.record.data.jobId === d.jobId)) return deny(`job ${d.jobId} was already started`);
      return ok();
    }
    case "build-complete": {
      const q = latest(history, (r) => r.data.kind === "queue-entry");
      const s = latest(history, (r) => r.data.kind === "build-start");
      if (!s || s.record.data.kind !== "build-start" || s.record.data.jobId !== d.jobId) return deny(`job ${d.jobId} was not started`);
      if (q?.record.data.kind === "queue-entry" && q.record.data.submittedFile.sha256 !== d.submittedFileSha256) return deny("submitted file hash differs from the queued file");
      if (Date.parse(d.completedAt) < Date.parse(d.startedAt)) return deny("completed before it started");
      if (rec.outcome === "failed" && !d.errors.length) return deny("a failed build must record its errors");
      return ok();
    }
    case "inspection": {
      const plan = latest(history, (r) => r.data.kind === "plan");
      if (!plan || plan.record.data.kind !== "plan") return deny("no inspection plan");
      const planIds = new Set(plan.record.data.inspectionPlan.map((p) => p.characteristic));
      const planned = model.characteristics.filter((c) => planIds.has(c.id));
      const ev = evaluateInspection(planned, d.measurements, evidenceIds);
      if (ev.outcome !== rec.outcome) return deny(`record says ${rec.outcome}, but the decision rules give ${ev.outcome}`);
      return ok({ inspection: ev });
    }
    case "nonconformance": {
      const insp = history.find((h) => h.record.recordId === d.inspectionRecord);
      if (!insp || insp.record.data.kind !== "inspection") return deny("names no inspection record in this ledger");
      if (insp.record.outcome === "accept") return deny("the inspection accepted every characteristic");
      if (all.some((h) => h.record.data.kind === "nonconformance" && h.record.data.ncrId === d.ncrId)) return deny(`NCR ${d.ncrId} already raised`);
      const bad = new Set(insp.inspection?.results.filter((r) => r.result !== "accept").map((r) => r.characteristic));
      for (const c of d.characteristics) if (!bad.has(c)) return deny(`characteristic ${c} was not rejected or held by that inspection`);
      return ok();
    }
    case "disposition": {
      const insp = latest(history, (r) => r.data.kind === "inspection");
      if (!insp || insp.record.recordId !== d.inspectionRecord) return deny("must disposition the latest inspection");
      if (insp.record.actor.keyId === rec.actor.keyId) return deny("disposition authority must not be the inspector");
      if (rec.outcome === "accept") {
        if (insp.record.outcome !== "accept") return deny(`can't accept: the inspection outcome is ${insp.record.outcome}; nonconforming or held results need an NCR and a disposition decision`);
        if (d.ncrId) return deny("an accept disposition doesn't cite an NCR");
        return ok();
      }
      const ncr = d.ncrId && history.find((h) => h.record.data.kind === "nonconformance" && h.record.data.ncrId === d.ncrId && h.record.data.inspectionRecord === insp.record.recordId);
      if (!ncr) return deny(`a ${rec.outcome} disposition needs an NCR raised against that inspection`);
      return ok();
    }
    case "closure": {
      if (d.incorporation) {
        const occ = model.occurrences.find((o) => o.occurrenceId === d.incorporation!.occurrence);
        if (!occ) return deny(`occurrence ${d.incorporation.occurrence} is not in the baseline`);
        if (itemKey(occ.child) !== itemKey(rec.item)) return deny(`occurrence ${occ.occurrenceId} uses ${itemKey(occ.child)}, not ${itemKey(rec.item)}`);
      }
      const all = [...history.flatMap((h) => h.record.evidence), ...rec.evidence];
      const missing = ctx.evidence ? all.filter((e) => !ctx.evidence!.has(e.sha256)) : all;
      if (missing.length) {
        const why = `evidence closure: ${missing.length} referenced evidence file(s) not hash-verified (${missing.slice(0, 3).map((e) => e.id).join(", ")}${missing.length > 3 ? ", …" : ""})`;
        if (mode === "create") return deny(why);
        held.push(why);
      }
      return ok();
    }
    case "delegation":
      return deny("delegation data needs the delegate action");
  }
}

// ---- Verification ----

export async function verifyLedger(json: string | unknown, ctx: WorkflowContext): Promise<LedgerResult> {
  const checks: LedgerCheck[] = [];
  const records: VerifiedRecord[] = [];
  const result = (verdict: LedgerResult["verdict"], extra: Partial<LedgerResult> = {}): LedgerResult => {
    const units = unitsIn(ctx.process, records);
    const instanceState = stateOf(ctx.process, records.filter((r) => !r.record.unit));
    return { verdict, checks, records, instanceState, units, state: units.length === 1 ? units[0]!.state : instanceState, head: records.at(-1)?.sha256, ...extra };
  };
  const fail = (id: string, message: string, extra: Partial<LedgerResult> = {}) => { checks.push({ id, status: "fail", message }); return result("rejected", extra); };

  let ledger: LedgerFile;
  try {
    ledger = LedgerFile.parse(typeof json === "string" ? JSON.parse(json) : json);
  } catch (e) {
    return fail("ledger", `invalid ledger: ${(e as Error).message}`);
  }
  const inst = ledger.instance;
  const def = ctx.process.definition;
  const auth = ctx.authority.config;
  const model = ctx.baseline.model;
  if (inst.packageId !== ctx.baseline.packageId || inst.manifestSha256 !== ctx.baseline.manifestSha256 || inst.baselineId !== model.baseline.id)
    return fail("ledger", `wrong baseline: ledger is for package ${inst.packageId} baseline ${inst.baselineId}, this package is ${ctx.baseline.packageId} baseline ${model.baseline.id}`, { instance: inst });
  if (inst.processId !== def.id) return fail("ledger", `ledger follows process ${inst.processId}; loaded process is ${def.id}`, { instance: inst });
  if (!model.items.some((i) => itemKey(i) === itemKey(inst.item))) return fail("ledger", `item ${itemKey(inst.item)} is not in baseline ${model.baseline.id}`, { instance: inst });
  checks.push({ id: "ledger", status: "pass", message: `ledger ${inst.id} for ${itemKey(inst.item)} in baseline ${inst.baselineId}, process ${def.id} v${def.version}` });

  if (Date.parse(auth.expires) < ctx.now.getTime()) return fail("authority", `authority configuration ${auth.id} serial ${auth.serial} expired ${auth.expires}`, { instance: inst });
  if (!auth.processes.some((p) => p.id === def.id && p.version === def.version && p.sha256 === ctx.process.sha256))
    return fail("authority", `authority ${auth.id} does not pin process ${def.id} v${def.version} with this digest`, { instance: inst });
  checks.push({ id: "authority", status: "pass", message: `${auth.fixture ? "LABORATORY FIXTURE " : ""}authority ${auth.id} serial ${auth.serial}${ctx.authority.signedBy ? `, signed by ${ctx.authority.signedBy.name}` : ", unsigned"}; pins ${def.id} v${def.version}` });

  let prev = await genesisDigest(inst.id, inst.manifestSha256);
  const heldAll: string[] = [];
  for (const [i, entry] of ledger.entries.entries()) {
    const seq = i + 1;
    const cid = `record:${seq}`;
    let rec: WorkflowRecord;
    try {
      rec = WorkflowRecord.parse(entry.record);
    } catch (e) {
      return fail(cid, `record ${seq}: invalid: ${(e as Error).message}`, { instance: inst });
    }
    const label = `record ${seq} (${rec.action})`;
    const digest = await canonicalSha256(entry.record);
    if (rec.seq !== seq) return fail(cid, `${label}: says it is record ${rec.seq}`, { instance: inst });
    if (rec.instance !== inst.id) return fail(cid, `${label}: belongs to workflow instance ${rec.instance}`, { instance: inst });
    if (itemKey(rec.item) !== itemKey(inst.item)) return fail(cid, `${label}: is for ${itemKey(rec.item)}, ledger is for ${itemKey(inst.item)}`, { instance: inst });
    if (!digestEquals(rec.prev, prev)) return fail(cid, `${label}: does not follow the previous record (chain broken)`, { instance: inst });
    if (!digestEquals(entry.signature.recordSha256, digest) || entry.signature.keyId !== rec.actor.keyId) return fail(cid, `${label}: signature is over different bytes or by a different key`, { instance: inst });
    const key = ctx.trustStore.keys.find((k) => k.keyId === rec.actor.keyId);
    if (!key) return fail(cid, `${label}: signer ${rec.actor.keyId} is not in the trust store`, { instance: inst });
    if (!(await verifyEd25519(key.publicKey, entry.signature.sig, recordSigningMessage(digest)))) return fail(cid, `${label}: signature does not verify`, { instance: inst });
    const ev = evaluateRecord(records, rec, ctx, "verify");
    if (ev.fatal) return fail(cid, `${label} by ${key.name}: denied: ${ev.fatal}`, { instance: inst });
    records.push({ record: rec, sha256: digest, key, via: ev.via!, held: ev.held, inspection: ev.inspection, suitability: ev.suitability, authorizedBy: ev.authorizedBy });
    heldAll.push(...ev.held);
    checks.push({ id: cid, status: ev.held.length ? "held" : "pass", message: `${label} by ${key.name} (${rec.actor.organization}) as ${rec.actor.role}: ${rec.outcome}${ev.held.length ? `; held: ${ev.held.join("; ")}` : ""}` });
    prev = digest;
  }
  const verdict = heldAll.length ? "held" : "verified";
  return result(verdict, { instance: inst, head: prev });
}

// ---- Creating records ----

export interface RecordInput {
  action: string;
  role: string;
  outcome: string;
  reason: string;
  data: RecordData;
  unit?: { serial?: string; lot?: string };
  evidence?: EvidenceRef[];
}

export function newLedger(ctx: WorkflowContext, item?: ItemRef, instanceId: string = crypto.randomUUID()): LedgerFile {
  const root = item ?? ctx.baseline.model.baseline.item;
  return {
    schema: "tdp-ledger/0.1",
    instance: { id: instanceId, processId: ctx.process.definition.id, packageId: ctx.baseline.packageId, manifestSha256: ctx.baseline.manifestSha256, baselineId: ctx.baseline.model.baseline.id, item: root },
    entries: [],
  };
}

/**
 * Builds, checks and signs the next record. The existing ledger must verify (held is allowed only
 * because of evidence the caller hasn't supplied); the new record must pass the gate in create mode,
 * which also needs present-tense authority freshness and every evidence file. Throws
 * TransitionDenied with the reason instead of signing a forbidden record.
 */
export async function appendRecord(
  ledger: LedgerFile,
  ctx: WorkflowContext,
  signer: KeyHandle,
  input: RecordInput,
  opts: { recordId?: string; at?: Date } = {},
): Promise<{ ledger: LedgerFile; record: WorkflowRecord; sha256: string }> {
  const before = await verifyLedger(ledger, ctx);
  if (before.verdict === "rejected") throw new Error(`ledger doesn't verify: ${before.checks.filter((c) => c.status === "fail").map((c) => c.message).join("; ")}`);
  const key = ctx.trustStore.keys.find((k) => k.keyId === signer.keyId);
  if (!key?.organization) throw new TransitionDenied("signing key is not a trusted key with an organization");
  const raw = {
    schema: "tdp-record/0.1" as const,
    recordId: opts.recordId ?? crypto.randomUUID(),
    seq: before.records.length + 1,
    instance: ledger.instance.id,
    baseline: { packageId: ledger.instance.packageId, manifestSha256: ledger.instance.manifestSha256, baselineId: ledger.instance.baselineId },
    item: ledger.instance.item,
    ...(input.unit ? { unit: input.unit } : {}),
    actor: { keyId: key.keyId, organization: key.organization.name, role: input.role },
    action: input.action,
    at: (opts.at ?? ctx.now).toISOString(),
    prev: before.head ?? (await genesisDigest(ledger.instance.id, ledger.instance.manifestSha256)),
    policy: { processId: ctx.process.definition.id, processVersion: ctx.process.definition.version, processSha256: ctx.process.sha256, authorityId: ctx.authority.config.id, authoritySerial: ctx.authority.config.serial },
    evidence: input.evidence ?? [],
    outcome: input.outcome,
    reason: input.reason,
    data: input.data,
  };
  const parsed = WorkflowRecord.safeParse(raw);
  if (!parsed.success) throw new TransitionDenied(`record is malformed: ${parsed.error.message}`);
  if (!ctx.evidence) throw new TransitionDenied("evidence files must be supplied when recording");
  const ev = evaluateRecord(before.records, parsed.data, ctx, "create");
  if (ev.fatal) throw new TransitionDenied(ev.fatal);
  const sha = await canonicalSha256(raw);
  const signature: RecordSignature = { schema: "tdp-record-signature/0.1", recordSha256: sha, keyId: key.keyId, alg: "Ed25519", sig: await signWith(signer, recordSigningMessage(sha)) };
  const out: LedgerFile = { ...ledger, entries: [...ledger.entries, { record: raw, signature }] };
  const after = await verifyLedger(out, ctx);
  if (after.verdict === "rejected") throw new Error(`record would make the ledger fail: ${after.checks.filter((c) => c.status === "fail").map((c) => c.message).join("; ")}`);
  return { ledger: out, record: parsed.data, sha256: sha };
}

// ---- Next actions and status ----

export interface NextAction {
  transition: string;
  description: string;
  roles: string[];
  requiresEvidence: string[];
  /** Reasons the step can't be taken now, independent of who takes it. Empty = available to an authorized actor. */
  blockedBy: string[];
}

/** The unit a status or next-action question is about: the given one, the ledger's only unit, or none (instance level). */
function scope(result: LedgerResult, unit?: PhysicalUnitRef): { unit?: PhysicalUnitRef; track: VerifiedRecord[]; state: string } {
  const u = unit ?? (result.units.length === 1 ? result.units[0]!.unit : undefined);
  if (!u) return { track: result.records.filter((r) => !r.record.unit), state: result.instanceState };
  const track = trackOf(result.records, u);
  return { unit: u, track, state: result.units.find((x) => x.key === unitKey(u))?.state ?? result.instanceState };
}

export function nextActions(result: LedgerResult, ctx: WorkflowContext, unit?: PhysicalUnitRef): NextAction[] {
  if (result.verdict === "rejected") return [];
  const def = ctx.process.definition;
  const sc = scope(result, unit);
  const now = ctx.now.toISOString();
  return def.transitions
    .filter((t) => t.from.includes(sc.state))
    .map((t) => {
      const blockedBy: string[] = [];
      for (const need of t.requires.actions)
        if (!latest(sc.track, (r) => r.action === need.id && (!need.outcomes || need.outcomes.includes(r.outcome)))) blockedBy.push(`needs ${need.id} first`);
      if (t.requires.freshAuthority) {
        const stale = freshnessProblem(ctx.authority.config, ctx.now);
        if (stale) blockedBy.push(stale);
      }
      if (Date.parse(ctx.authority.config.expires) < ctx.now.getTime()) blockedBy.push(`authority configuration expired ${ctx.authority.config.expires}`);
      if (ctx.successors?.length && NEW_WORK.has(t.kind)) blockedBy.push(`baseline superseded by ${ctx.successors[0]!.baselineId}: new work follows the new baseline`);
      if (t.requires.authorization) {
        const a = findAuthorization(result.records, ctx, t.requires.authorization, { unit: sc.unit, transition: t.id }, now);
        if (a.problem) blockedBy.push(`not authorized: ${a.problem}`);
      }
      if (t.kind === "plan") {
        const stale = characteristicsNeedingGeometryReview(ctx.baseline.model);
        if (stale.length) blockedBy.push(`geometry review needed for ${stale.map((s) => s.id).join(", ")} (record it in the plan)`);
      }
      const description = t.requires.unit && !sc.unit ? `${t.description} (for a unit)` : t.description;
      return { transition: t.id, description, roles: t.roles, requiresEvidence: t.requires.evidence, blockedBy };
    });
}

export type StatusLevel = "ok" | "warn" | "fail" | "none";
export interface StatusLine { level: StatusLevel; text: string }
export interface WorkflowStatus {
  baseline: StatusLine;
  sourceRelease: StatusLine;
  operation: StatusLine;
  inspection: StatusLine;
  disposition: StatusLine;
}

/** Separate answers. None of them is implied by package integrity, or by each other. Scoped to one unit when given. */
export function workflowStatus(result: LedgerResult, ctx: WorkflowContext, unit?: PhysicalUnitRef): WorkflowStatus {
  const sc = scope(result, unit);
  const h = sc.track;
  const who = sc.unit ? ` (${unitLabel(sc.unit)})` : "";
  const succ = ctx.successors?.[0];
  const baseline: StatusLine = succ
    ? { level: "warn", text: `Superseded by ${succ.baselineId}: no new work under ${ctx.baseline.model.baseline.id}; units in progress may be completed` }
    : { level: "ok", text: `No newer baseline known for ${ctx.baseline.model.baseline.id} (only baselines you have loaded are known)` };
  const fixture = ctx.authority.config.fixture ? " (laboratory fixture authority, not a live PLM)" : "";
  const src = latest(h, (r) => r.data.kind === "source-release");
  const sourceRelease: StatusLine = src && src.record.data.kind === "source-release"
    ? { level: "ok", text: `Source release evidence verified: ${src.record.data.system} ${src.record.data.releaseState} rev ${src.record.data.revision}${fixture}` }
    : { level: "none", text: "Source release evidence not established" };

  const next = result.verdict === "rejected" ? [] : nextActions(result, ctx, sc.unit);
  const gated = next.filter((n) => ctx.process.definition.transitions.find((t) => t.id === n.transition)?.requires.authorization);
  const operation: StatusLine = result.verdict === "rejected"
    ? { level: "fail", text: "Operation not authorized: ledger rejected" }
    : gated.length === 0
      ? { level: "none", text: `No authorized operation pending in state ${sc.state}${who}` }
      : gated.some((g) => !g.blockedBy.length)
        ? { level: "ok", text: `Operation authorized${who}: ${gated.filter((g) => !g.blockedBy.length).map((g) => g.transition).join(", ")}` }
        : { level: "fail", text: `Operation not authorized${who}: ${gated[0]!.blockedBy.join("; ")}` };

  const insp = latest(h, (r) => r.data.kind === "inspection");
  const inspection: StatusLine = !insp
    ? { level: "none", text: `Not inspected${who}` }
    : insp.record.outcome === "accept"
      ? { level: "ok", text: `Inspection accepted${who} (measurement outcome; not a disposition)` }
      : insp.record.outcome === "reject"
        ? { level: "fail", text: `Inspection rejected one or more characteristics${who}` }
        : { level: "warn", text: `Inspection indeterminate${who}: held for missing or insufficient measurement evidence` };

  const disp = latest(h, (r) => r.data.kind === "disposition");
  const disposition: StatusLine = disp
    ? { level: disp.record.outcome === "accept" || disp.record.outcome === "use-as-is" ? "ok" : "warn", text: `Dispositioned ${disp.record.outcome}${who} by ${disp.key.name}` }
    : { level: "none", text: `No disposition${who}` };
  return { baseline, sourceRelease, operation, inspection, disposition };
}

// ---- Checkpoints (detect truncation against an independently retained copy) ----

export const Checkpoint = z
  .object({ schema: z.literal("tdp-checkpoint/0.1"), instance: z.string().uuid(), count: z.number().int().nonnegative(), head: sha256, createdAt: isoTime })
  .strict();
export type Checkpoint = z.infer<typeof Checkpoint>;

export async function makeCheckpoint(result: LedgerResult, now = new Date()): Promise<Checkpoint> {
  if (!result.instance || result.verdict === "rejected") throw new Error("only a ledger that verifies can be checkpointed");
  return { schema: "tdp-checkpoint/0.1", instance: result.instance.id, count: result.records.length, head: result.head!, createdAt: now.toISOString() };
}

/**
 * A checkpoint only helps if it was kept somewhere the ledger's holder can't change: by the
 * receiving organization, or in a later custody log. It proves the ledger still contains the history
 * the checkpoint saw, not that nothing happened since.
 */
export function checkCheckpoint(result: LedgerResult, cp: Checkpoint): string | null {
  if (result.instance?.id !== cp.instance) return `checkpoint is for instance ${cp.instance}`;
  if (cp.count === 0) return null;
  if (result.records.length < cp.count) return `ledger has ${result.records.length} verified records, but a retained checkpoint saw ${cp.count}: history was truncated`;
  if (result.records[cp.count - 1]!.sha256 !== cp.head) return `record ${cp.count} differs from the retained checkpoint: history was rewritten or forked`;
  return null;
}
