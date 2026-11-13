// Workflow CLI commands (records, evidence, sync), separate from argument parsing so tests can call them.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { sha256Hex, utf8 } from "../src/core/bytes";
import { canonicalSha256 } from "../src/core/canonical";
import { loadAuthority, type AuthorityConfig } from "../src/core/authority";
import type { TrustStore } from "../src/core/schema";
import { buildEvidenceBundle } from "../src/core/evidence";
import { type SourceAdapter, AckSet, FixtureState, LocalFixtureAdapter, ProposalSet, PublishingRecipe, buildProposals, importAcknowledgements } from "../src/core/exchange";
import { loadProcess } from "../src/core/process";
import { defaultPolicy } from "../src/core/policy";
import {
  Checkpoint,
  LedgerFile,
  RecordData,
  appendRecord,
  baselineFrom,
  checkCheckpoint,
  evidenceStoreFrom,
  successorsOf,
  unitLabel,
  makeCheckpoint,
  newLedger,
  nextActions,
  verifyLedger,
  workflowStatus,
  type EvidenceRef,
  type LedgerResult,
  type WorkflowContext,
} from "../src/core/records";
import { loadAnchors, loadTrustStoreFile } from "../src/core/truststore";
import { verifyPackage, type VerifyResult } from "../src/core/verify";
import type { KeyHandle } from "../src/core/signing";

export interface ContextArgs {
  package: string;
  trust: string;
  authority: string;
  process: string;
  anchors?: string;
  evidenceDir?: string;
  at?: string;
  /** Other packages to check for baselines that supersede this one. */
  successors?: string[];
}

export interface LoadedContext {
  ctx: WorkflowContext;
  verify: VerifyResult;
  trustStoreSha256: string;
  /** Lines describing what was loaded, for the CLI to print. */
  notes: string[];
}

const MEDIA: Record<string, string> = { json: "application/json", csv: "text/csv", txt: "text/plain", pdf: "application/pdf", stp: "model/step", step: "model/step", "3mf": "model/3mf", png: "image/png", jpg: "image/jpeg" };
export const mediaTypeFor = (path: string) => MEDIA[path.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => (n.startsWith(".") ? [] : statSync(join(dir, n)).isDirectory() ? listFiles(join(dir, n)) : [join(dir, n)]));
}

/** Loads and verifies everything a workflow decision depends on. Throws with the reason if any of it fails. */
export async function loadContext(a: ContextArgs): Promise<LoadedContext> {
  const now = a.at ? new Date(a.at) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`--at ${a.at} is not a time`);
  const notes: string[] = [];
  const anchors = a.anchors ? await loadAnchors(readFileSync(a.anchors, "utf8")) : undefined;
  const trustJson = readFileSync(a.trust, "utf8");
  const trust = await loadTrustStoreFile(trustJson, { anchors, now });
  notes.push(`trust store: ${trust.store.keys.length} keys${trust.signedBy ? `, signed by ${trust.signedBy.name}, serial ${trust.store.serial}` : ", unsigned"}`);
  const authority = await loadAuthority(readFileSync(a.authority, "utf8"), { anchors });
  notes.push(`authority: ${authority.config.fixture ? "LABORATORY FIXTURE " : ""}${authority.config.id} serial ${authority.config.serial}${authority.signedBy ? `, signed by ${authority.signedBy.name}` : ", unsigned"}`);
  const process = await loadProcess(readFileSync(a.process, "utf8"));
  notes.push(`process: ${process.definition.id} v${process.definition.version} (${process.sha256.slice(0, 16)}…)`);
  const verify = await verifyPackage(new Uint8Array(readFileSync(a.package)), trust.store, defaultPolicy, now);
  if (verify.verdict !== "trusted") throw new Error(`package ${a.package} is not trusted: ${verify.checks.filter((c) => c.status === "fail").map((c) => c.message).join("; ")}`);
  notes.push(`package: ${verify.manifest!.package.partNumber} rev ${verify.manifest!.package.revision}, ${verify.manifest!.schema}, integrity verified`);
  const evidence = a.evidenceDir ? await evidenceStoreFrom(listFiles(a.evidenceDir).map((f) => ({ name: basename(f), bytes: new Uint8Array(readFileSync(f)) }))) : undefined;
  if (evidence) notes.push(`evidence: ${evidence.size} files hashed from ${a.evidenceDir}`);
  const baseline = baselineFrom(verify);
  const others = await Promise.all((a.successors ?? []).map((f) => verifyPackage(new Uint8Array(readFileSync(f)), trust.store, defaultPolicy, now)));
  for (const [i, r] of others.entries()) if (r.verdict !== "trusted") throw new Error(`--successor ${a.successors![i]} is not trusted`);
  const successors = successorsOf(baseline, others);
  if (a.successors?.length) notes.push(successors.length ? `superseded by: ${successors.map((s) => s.baselineId).join(", ")}` : "no loaded package supersedes this baseline");
  return {
    ctx: { baseline, authority, process, trustStore: trust.store, now, skewMs: defaultPolicy.clockSkewMs, evidence, successors },
    verify,
    trustStoreSha256: await sha256Hex(utf8.encode(trustJson)),
    notes,
  };
}

export const readLedger = (path: string) => LedgerFile.parse(JSON.parse(readFileSync(path, "utf8")));

export function createLedger(c: LoadedContext, item?: string): LedgerFile {
  const ref = item ? (([itemId, revision]) => ({ itemId: itemId!, revision: revision! }))(item.split("@")) : undefined;
  if (ref && !c.ctx.baseline.model.items.some((i) => i.itemId === ref.itemId && i.revision === ref.revision)) throw new Error(`item ${item} is not in the baseline`);
  return newLedger(c.ctx, ref);
}

/** `--evidence ID=TAG=PATH`: hashes the file and builds the reference. */
export async function evidenceRefs(specs: string[], synthetic: boolean): Promise<EvidenceRef[]> {
  const out: EvidenceRef[] = [];
  for (const s of specs) {
    const [id, tag, ...rest] = s.split("=");
    const path = rest.join("=");
    if (!id || !tag || !path) throw new Error(`--evidence must be ID=TAG=PATH, got ${s}`);
    const bytes = new Uint8Array(readFileSync(path));
    out.push({ id, tag, sha256: await sha256Hex(bytes), mediaType: mediaTypeFor(path), description: basename(path), synthetic });
  }
  return out;
}

export async function addRecord(
  ledger: LedgerFile,
  c: LoadedContext,
  key: KeyHandle,
  opts: { action: string; role: string; outcome: string; reason: string; dataJson: string; serial?: string; lot?: string; evidence: EvidenceRef[] },
) {
  const data = RecordData.parse(JSON.parse(opts.dataJson));
  const unit = opts.serial || opts.lot ? { ...(opts.serial ? { serial: opts.serial } : {}), ...(opts.lot ? { lot: opts.lot } : {}) } : undefined;
  return appendRecord(ledger, c.ctx, key, { action: opts.action, role: opts.role, outcome: opts.outcome, reason: opts.reason, data, unit, evidence: opts.evidence });
}

export function formatLedger(r: LedgerResult, c: LoadedContext): string[] {
  const lines: string[] = [];
  for (const ch of r.checks) lines.push(`${ch.status.toUpperCase().padEnd(4)}  ${ch.id}  ${ch.message}`);
  lines.push("status (each established separately):");
  lines.push(`  package integrity  ${c.verify.verdict === "trusted" ? "verified" : "REJECTED"}`);
  const scopes = r.units.length > 1 ? [undefined, ...r.units.map((u) => u.unit)] : [undefined];
  for (const unit of scopes) {
    const st = workflowStatus(r, c.ctx, unit);
    if (unit) lines.push(`unit ${unitLabel(unit)}:`);
    if (!unit) {
      lines.push(`  baseline           ${st.baseline.text}`);
      lines.push(`  source release     ${st.sourceRelease.text}`);
    }
    if (unit || r.units.length <= 1) {
      lines.push(`  operation          ${st.operation.text}`);
      lines.push(`  inspection         ${st.inspection.text}`);
      lines.push(`  disposition        ${st.disposition.text}`);
    }
    if (r.verdict === "rejected") continue;
    const state = unit ? r.units.find((u) => unitLabel(u.unit) === unitLabel(unit))!.state : r.units.length > 1 ? r.instanceState : r.state;
    lines.push(`  state: ${state}${!unit && r.units.length > 1 ? " (instance level)" : ""}`);
    for (const n of nextActions(r, c.ctx, unit)) lines.push(`    next: ${n.transition} (${n.roles.join(" or ")})${n.requiresEvidence.length ? ` evidence ${n.requiresEvidence.join(", ")}` : ""}${n.blockedBy.length ? `  BLOCKED: ${n.blockedBy.join("; ")}` : ""}`);
  }
  return lines;
}

export async function checkpointFor(r: LedgerResult, now = new Date()) {
  return makeCheckpoint(r, now);
}

export function checkAgainst(r: LedgerResult, checkpointJson: string): string | null {
  return checkCheckpoint(r, Checkpoint.parse(JSON.parse(checkpointJson)));
}

export async function exportEvidence(ledgerJson: string, c: LoadedContext, opts: { proposals?: string; acks?: string } = {}) {
  const ledger = JSON.parse(ledgerJson);
  const r = await verifyLedger(ledger, c.ctx);
  let reconciliation;
  if (opts.proposals) {
    const proposals = ProposalSet.parse(JSON.parse(readFileSync(opts.proposals, "utf8")));
    const rows = opts.acks ? (await importAcknowledgements(proposals, AckSet.parse(JSON.parse(readFileSync(opts.acks, "utf8"))))).rows : undefined;
    reconciliation = { proposals, rows };
  }
  return buildEvidenceBundle({ verify: c.verify, trustStoreSha256: c.trustStoreSha256, ledger: r, ctx: c.ctx, ledgerSha256: await canonicalSha256(ledger), reconciliation, now: c.ctx.now });
}

export async function syncExport(ledgerJson: string, c: LoadedContext, recipeJson: string, fixtureJson: string, knownAcksJson?: string, proposalsJson?: string) {
  const r = await verifyLedger(JSON.parse(ledgerJson), c.ctx);
  const adapter = new LocalFixtureAdapter(FixtureState.parse(JSON.parse(fixtureJson)));
  const known = knownAcksJson && proposalsJson ? (await importAcknowledgements(ProposalSet.parse(JSON.parse(proposalsJson)), AckSet.parse(JSON.parse(knownAcksJson)))).versions : undefined;
  return buildProposals(PublishingRecipe.parse(JSON.parse(recipeJson)), c.ctx.baseline, r, adapter.describe(), { now: c.ctx.now, knownVersions: known });
}

export async function syncApplyFixture(proposalsJson: string, fixtureJson: string, now = new Date(), signer?: KeyHandle) {
  const adapter = new LocalFixtureAdapter(FixtureState.parse(JSON.parse(fixtureJson)), signer);
  const acks = await adapter.reconcile(ProposalSet.parse(JSON.parse(proposalsJson)), now);
  return { acks, state: adapter.state };
}

export async function syncImport(proposalsJson: string, acksJson: string, trust?: { trustStore: TrustStore; authority: AuthorityConfig; now?: Date }) {
  return importAcknowledgements(ProposalSet.parse(JSON.parse(proposalsJson)), AckSet.parse(JSON.parse(acksJson)), trust);
}

export async function checkPublication(c: LoadedContext, adapter: SourceAdapter | string) {
  const a = typeof adapter === "string" ? new LocalFixtureAdapter(FixtureState.parse(JSON.parse(adapter))) : adapter;
  return a.checkPublication(c.ctx.baseline.model);
}
