// Synthetic laboratory fixtures for the TRL 4 demonstrator: a SURROGATE printed latch for a
// build-plate handling assembly, its engineering model, a laboratory authority fixture, two process
// definitions, demo keys, and synthetic evidence. Everything here is made up and labeled as such.
// The real controlled design, approvals, printer runs and measurements must come from the program;
// nothing in this file stands in for them.
//
// Deterministic on purpose, so `npm run lab` reproduces the same bytes: demo keys are derived from
// public seeds (anyone can recompute them; they are worthless outside this demo), UUIDs are derived
// from names, and the clock is fixed.
import { unzipSync, zipSync } from "fflate";
import { fromBase64, sha256Hex, toBase64, utf8 } from "../src/core/bytes";
import { canonicalSha256 } from "../src/core/canonical";
import { signConfig, type AuthorityConfig } from "../src/core/authority";
import type { EngineeringModel } from "../src/core/engineering";
import { buildPackage, type PackInput } from "../src/core/pack";
import type { ProcessDefinition } from "../src/core/process";
import {
  genesisDigest,
  recordSigningMessage,
  type EvidenceRef,
  type LedgerFile,
  type RecordData,
} from "../src/core/records";
import type { SignerRole, TrustStore } from "../src/core/schema";
import { signWith } from "../src/core/signing";
import { signTrustStore, type Anchors } from "../src/core/truststore";
import { samplePdf } from "./sample-data";
import { writeStep, type Prism } from "./step-writer";

export const SYNTHETIC = "SYNTHETIC SURROGATE: not the controlled design. Demonstration data only; dimensions, limits, approvals, builds and measurements are invented.";

/** Fixed scenario clock. */
export const T0 = Date.parse("2026-11-10T13:00:00Z");
export const at = (minutes: number) => new Date(T0 + minutes * 60_000);
export const iso = (minutes: number) => at(minutes).toISOString();
/** Evaluation time used for the generated outputs: two days into the scenario. */
export const LAB_NOW = at(48 * 60);

/** A UUID derived from a name (version-4 layout), so fixtures are reproducible. */
export async function uuidFor(name: string): Promise<string> {
  const h = await sha256Hex(utf8.encode(`tdp-lab-uuid/${name}`));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface DemoKey {
  id: string;
  keyId: string;
  publicKey: string;
  privateKey: CryptoKey;
  /** PKCS#8 bytes, only so the lab tool can write an encrypted CLI key file. */
  pkcs8: Uint8Array;
}

/** Ed25519 key from a public seed. DEMO ONLY: the seed is in this source file. */
export async function demoKey(name: string): Promise<DemoKey> {
  const seed = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8.encode(`tdp-lab-demo-key/${name}`)));
  const pkcs8 = new Uint8Array([...[0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20], ...seed]);
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8 as BufferSource, { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  const raw = fromBase64(jwk.x!.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (jwk.x!.length % 4)) % 4));
  const publicKey = toBase64(raw);
  const keyId = (await sha256Hex(raw)).slice(0, 32);
  return { id: name, keyId, publicKey, privateKey, pkcs8 };
}

export const ORG = {
  design: "Lab Design Authority (synthetic)",
  cell: "Lab Print Cell (synthetic)",
  lab: "Lab Inspection (synthetic)",
  plm: "Lab Fixture PLM (synthetic)",
};

/** Who's who. `signing` = package-signing roles; workflow roles are granted in the authority fixture. */
export const PEOPLE: { id: string; name: string; org: string; signing: SignerRole[]; workflow: string[]; mayDelegate?: boolean; processes?: string[] }[] = [
  { id: "author", name: "Dana Author (demo)", org: ORG.design, signing: ["author"], workflow: [] },
  { id: "approver", name: "Avery Approver (demo)", org: ORG.design, signing: ["approver"], workflow: [] },
  { id: "req-owner", name: "Riley Requirement Owner (demo)", org: ORG.design, signing: [], workflow: ["requirement-owner"] },
  { id: "config-mgr", name: "Casey Configuration Manager (demo)", org: ORG.design, signing: [], workflow: ["configuration-manager"] },
  { id: "design-eng", name: "Drew Design Engineer (demo)", org: ORG.design, signing: [], workflow: ["design-engineer"] },
  { id: "mfg-authority", name: "Morgan Manufacturing Authority (demo)", org: ORG.design, signing: [], workflow: ["manufacturing-authority"] },
  { id: "mrb", name: "Mel Disposition Authority (demo)", org: ORG.design, signing: [], workflow: ["disposition-authority"] },
  { id: "mfg-eng", name: "Sam Manufacturing Engineer (demo)", org: ORG.cell, signing: [], workflow: ["manufacturing-engineer"] },
  { id: "planner", name: "Pat Planner (demo)", org: ORG.cell, signing: [], workflow: ["planner"] },
  { id: "operator", name: "Oli Operator (demo)", org: ORG.cell, signing: [], workflow: ["operator"] },
  { id: "cell-lead", name: "Lee Cell Lead (demo)", org: ORG.cell, signing: [], workflow: ["operator"], mayDelegate: true },
  { id: "operator2", name: "Jo Second-Shift Operator (demo, delegated only)", org: ORG.cell, signing: [], workflow: [] },
  { id: "revoked-op", name: "Rex Revoked Operator (demo)", org: ORG.cell, signing: [], workflow: ["operator"] },
  { id: "outsider", name: "Ola Outsider (demo, no grants)", org: ORG.cell, signing: [], workflow: [] },
  { id: "inspector", name: "Ines Inspector (demo)", org: ORG.lab, signing: [], workflow: ["inspector"] },
  { id: "inspector2", name: "Ivo Second Inspector (demo)", org: ORG.lab, signing: [], workflow: ["inspector"] },
  { id: "quality", name: "Quinn Quality Engineer (demo)", org: ORG.lab, signing: [], workflow: ["quality-engineer"] },
  // Signs acknowledgements for the fixture source system; holds no workflow role.
  { id: "source-plm", name: "Lab Fixture PLM acknowledgement key (demo)", org: ORG.plm, signing: [], workflow: [] },
];

// ---- Geometry and package ----

const latchOutline = (tab: number): [number, number][] => [[0, 0], [40, 0], [40, tab], [8, tab], [8, 20], [0, 20]];
const latch = (rev: "A" | "B", dx = 0, dy = 0): Prism => ({ outline: latchOutline(rev === "A" ? 6 : 8).map(([x, y]) => [x + dx, y + dy]), z0: 0, height: 12 });
const base: Prism = { outline: [[0, 0], [120, 0], [120, 30], [0, 30]], z0: -5, height: 5 };

export type LabRevision = "A" | "B";
export const PART = "SYN-PH-2001";
export const ASSY = "SYN-PH-2000";

export interface LabPackage {
  revision: LabRevision;
  tdp: Uint8Array;
  model: EngineeringModel;
  packageId: string;
}

/** Builds the surrogate package. Rev B thickens the latch tab 6 → 8 mm and carries one geometry link over unchanged (so it's stale). */
export async function buildLabPackage(revision: LabRevision, author: DemoKey, approver: DemoKey, prior?: { packageId: string; manifestSha256: string; baselineId: string }): Promise<LabPackage> {
  const packageId = await uuidFor(`package/${ASSY}/${revision}`);
  const tab = revision === "A" ? 6 : 8;
  const partStep = writeStep(PART, "Build Plate Handle Latch (SYNTHETIC SURROGATE)", [latch(revision)]);
  const priorPartStep = writeStep(PART, "Build Plate Handle Latch (SYNTHETIC SURROGATE)", [latch("A")]);
  const assyStep = writeStep(ASSY, "Build-Plate Handling Assembly (SYNTHETIC SURROGATE)", [base, latch(revision, 5, 5), latch(revision, 75, 5)]);
  const inputs: PackInput[] = [
    { path: `drawings/${PART}_${revision}.pdf`, bytes: samplePdf("Build Plate Handle Latch - SYNTHETIC SURROGATE", PART, revision, [latch(revision)]), mediaType: "application/pdf", role: "drawing", partNumber: PART, revision },
    { path: `models/${PART}_${revision}.stp`, bytes: partStep, mediaType: "model/step", role: "model", partNumber: PART, revision },
    { path: `drawings/${ASSY}_${revision}.pdf`, bytes: samplePdf("Build-Plate Handling Assembly - SYNTHETIC SURROGATE", ASSY, revision, [base, latch(revision, 5, 5), latch(revision, 75, 5)]), mediaType: "application/pdf", role: "drawing", partNumber: ASSY, revision },
    { path: `models/${ASSY}_${revision}.stp`, bytes: assyStep, mediaType: "model/step", role: "model", partNumber: ASSY, revision },
  ];
  const csv = `part_number,revision,name,quantity,parent\n${ASSY},${revision},Build-Plate Handling Assembly (synthetic),1,\n${PART},${revision},Build Plate Handle Latch (synthetic),2,${ASSY}\n`;
  inputs.push({ path: "bom/bom.csv", bytes: utf8.encode(csv), mediaType: "text/csv", role: "bom" });
  const sha = async (p: string) => sha256Hex(inputs.find((i) => i.path === p)!.bytes);
  const part = { itemId: PART, revision };
  const assy = { itemId: ASSY, revision };
  const sourceRef = (item: string) => ({ surrogateFor: "onshape", documentId: `SYNTH-DOC-${item}`, versionId: `SYNTH-V-${item}-${revision}`, elementId: `SYNTH-EL-${item}` });
  const model: EngineeringModel = {
    schema: "tdp-engineering/0.1",
    synthetic: true,
    label: SYNTHETIC,
    baseline: {
      id: `BL-${ASSY}-${revision}`,
      packageId,
      item: assy,
      effectivity: { kind: "serial", from: "SN-0001", to: "SN-0050" },
      ...(prior ? { supersedes: prior } : {}),
    },
    sources: [
      { id: `SRC-${PART}`, system: "lab-fixture", reference: sourceRef(PART), declaredRevision: revision, declaredReleaseState: "Released", capture: "fixture", capturedAt: iso(-60) },
      { id: `SRC-${ASSY}`, system: "lab-fixture", reference: sourceRef(ASSY), declaredRevision: revision, declaredReleaseState: "Released", capture: "fixture", capturedAt: iso(-60) },
    ],
    items: [
      { itemId: ASSY, revision, partNumber: ASSY, name: "Build-Plate Handling Assembly (synthetic)", source: `SRC-${ASSY}` },
      { itemId: PART, revision, partNumber: PART, name: "Build Plate Handle Latch (synthetic)", source: `SRC-${PART}`, envelopeMm: [40, 20, 12], material: "PETG" },
    ],
    occurrences: [
      { occurrenceId: "OCC-2000-LATCH-L", parent: assy, child: part, quantity: 1, findNumber: "1" },
      { occurrenceId: "OCC-2000-LATCH-R", parent: assy, child: part, quantity: 1, findNumber: "2" },
    ],
    requirements: [
      { id: "REQ-001", version: 1, title: "Latch tab retains the build plate (synthetic)", text: "SYNTHETIC: the latch tab thickness shall be within the drawing limits so the plate is retained without binding.", appliesTo: part, verification: "inspection", characteristics: ["CH-001"] },
      { id: "REQ-002", version: 1, title: "Latch fits the handle envelope (synthetic)", text: "SYNTHETIC: overall length and hook height shall be within limits so the latch fits its pocket.", appliesTo: part, verification: "inspection", characteristics: ["CH-002", "CH-003"] },
      { id: "REQ-003", version: 1, title: "Latch material (synthetic)", text: "SYNTHETIC: the latch shall be printed in PETG.", appliesTo: part, verification: "process-evidence", characteristics: [] },
    ],
    characteristics: [
      { id: "CH-001", requirement: "REQ-001", item: part, name: "tab thickness", unit: "mm", nominal: tab, lower: tab - 0.2, upper: tab + 0.2, decisionRule: "guard-banded", geometry: ["GL-001"] },
      { id: "CH-002", requirement: "REQ-002", item: part, name: "overall length", unit: "mm", nominal: 40, lower: 39.7, upper: 40.3, decisionRule: "simple-acceptance", minTur: 4, geometry: ["GL-002"] },
      { id: "CH-003", requirement: "REQ-002", item: part, name: "hook height", unit: "mm", nominal: 20, lower: 19.7, upper: 20.3, decisionRule: "guard-banded" },
    ],
    artifacts: [
      { id: "ART-PART-STEP", path: `models/${PART}_${revision}.stp`, sha256: await sha(`models/${PART}_${revision}.stp`), class: "cad-model", item: part, authoritative: true, source: `SRC-${PART}` },
      { id: "ART-PART-DWG", path: `drawings/${PART}_${revision}.pdf`, sha256: await sha(`drawings/${PART}_${revision}.pdf`), class: "drawing", item: part, authoritative: true, source: `SRC-${PART}` },
      { id: "ART-ASSY-STEP", path: `models/${ASSY}_${revision}.stp`, sha256: await sha(`models/${ASSY}_${revision}.stp`), class: "cad-model", item: assy, authoritative: true, source: `SRC-${ASSY}` },
      { id: "ART-ASSY-DWG", path: `drawings/${ASSY}_${revision}.pdf`, sha256: await sha(`drawings/${ASSY}_${revision}.pdf`), class: "drawing", item: assy, authoritative: true, source: `SRC-${ASSY}` },
      { id: "ART-BOM", path: "bom/bom.csv", sha256: await sha("bom/bom.csv"), class: "bom", authoritative: false },
    ],
    geometryLinks: [
      // Valid only for these exact STEP bytes; a solid index is not feature identity.
      { id: "GL-001", artifact: "ART-PART-STEP", method: "step-solid-index", selector: "solid 1 (tab region, by inspection of the drawing)", stability: "this-artifact-only", artifactSha256: await sha(`models/${PART}_${revision}.stp`), item: part },
      // Rev B carries this one over from rev A without re-deriving it: stale, so planning must review it.
      { id: "GL-002", artifact: "ART-PART-STEP", method: "step-solid-index", selector: "solid 1 (overall length)", stability: "this-artifact-only", artifactSha256: await sha256Hex(revision === "A" ? partStep : priorPartStep), item: part },
    ],
    relationships: [
      { type: "verifies", from: "CH-001", to: "REQ-001" },
      { type: "verifies", from: "CH-002", to: "REQ-002" },
      { type: "verifies", from: "CH-003", to: "REQ-002" },
      { type: "describes", from: "ART-PART-STEP", to: `${PART}@${revision}` },
      { type: "describes", from: "ART-PART-DWG", to: `${PART}@${revision}` },
      ...(prior ? [{ type: "supersedes" as const, from: `BL-${ASSY}-${revision}`, to: prior.baselineId }] : []),
    ],
    provenance: { generatedBy: "tools/lab-fixtures.ts", generatedAt: iso(-60), note: SYNTHETIC },
  };
  inputs.push({ path: "engineering/model.json", bytes: utf8.encode(JSON.stringify(model, null, 2) + "\n"), mediaType: "application/json", role: "spec" });
  const tdp = await buildPackage(
    { id: packageId, title: `Build-Plate Handling Assembly (SYNTHETIC SURROGATE) rev ${revision}`, partNumber: ASSY, revision, created: iso(revision === "A" ? -30 : 24 * 60), expires: "2028-11-10T00:00:00.000Z", distribution: SYNTHETIC },
    inputs,
    [
      { partNumber: ASSY, revision, name: "Build-Plate Handling Assembly (synthetic)", quantity: 1, files: [`drawings/${ASSY}_${revision}.pdf`, `models/${ASSY}_${revision}.stp`] },
      { partNumber: PART, revision, name: "Build Plate Handle Latch (synthetic)", quantity: 2, parent: ASSY, files: [`drawings/${PART}_${revision}.pdf`, `models/${PART}_${revision}.stp`] },
    ],
    [{ ...author, role: "author" }, { ...approver, role: "approver" }],
    at(revision === "A" ? -25 : 24 * 60 + 5),
    { engineering: "engineering/model.json" },
  );
  // Fixed zip entry times so `npm run lab` reproduces the same package bytes.
  const mtime = new Date("2026-11-10T00:00:00Z");
  const stable = zipSync(Object.fromEntries(Object.entries(unzipSync(tdp)).map(([k, v]) => [k, [v, { mtime }]])));
  return { revision, tdp: stable, model, packageId };
}

// ---- Process definitions ----

const roleList = (ids: string[]) => ids.map((id) => ({ id, description: `${id.replace(/-/g, " ")} (workflow role)` }));

/** Reference process: requirements → source release → suitability → plan → authorize → queue → build → inspect → disposition → close. */
export function printedPartProcess(version = 1): ProcessDefinition {
  return {
    schema: "tdp-process/0.1",
    id: "printed-part",
    version,
    title: "Printed part: bounded laboratory build",
    label: "Reference laboratory process (synthetic demonstration configuration)",
    synthetic: true,
    roles: roleList(["requirement-owner", "configuration-manager", "manufacturing-engineer", "design-engineer", "planner", "manufacturing-authority", "operator", "inspector", "quality-engineer", "disposition-authority"]),
    states: ["baseline-received", "requirements-approved", "source-released", "suitability-review", "process-qualified", "planned", "authorized", "queued", "building", "built", "inspected", "inspection-rejected", "inspection-held", "nonconforming", "dispositioned", "scrapped", "closed"],
    initial: "baseline-received",
    terminal: ["closed"],
    operations: ["queue", "build"],
    allowDelegation: true,
    transitions: [
      { id: "approve-requirements", kind: "requirements-approval", description: "Requirement owner approves the requirement set for this item revision", from: ["baseline-received"], outcomes: { approved: "requirements-approved" }, roles: ["requirement-owner"], organizations: [ORG.design], requires: { actions: [], evidence: [], freshAuthority: false, unit: false }, distinctActorFrom: [], distinctOrganizationFrom: [] },
      { id: "record-source-release", kind: "source-release", description: "Configuration manager records source-system release evidence", from: ["requirements-approved"], outcomes: { verified: "source-released" }, roles: ["configuration-manager"], requires: { actions: [], evidence: ["source-release-record"], freshAuthority: false, unit: false }, distinctActorFrom: [], distinctOrganizationFrom: [] },
      { id: "review-suitability", kind: "suitability", description: "Manufacturing engineer reviews process suitability against the requirements", from: ["source-released"], outcomes: { suitable: "process-qualified", "review-required": "suitability-review", "not-suitable": "source-released" }, roles: ["manufacturing-engineer"], requires: { actions: [], evidence: ["capability-study", "calibration-certificate"], freshAuthority: false, unit: false }, distinctActorFrom: [], distinctOrganizationFrom: [] },
      { id: "engineering-gap-review", kind: "suitability-review", description: "Design engineer accepts or rejects each suitability gap", from: ["suitability-review"], outcomes: { accepted: "process-qualified", rejected: "source-released" }, roles: ["design-engineer"], requires: { actions: [], evidence: [], freshAuthority: false, unit: false }, distinctActorFrom: ["review-suitability"], distinctOrganizationFrom: [] },
      { id: "plan-build", kind: "plan", description: "Planner records the build and inspection plan", from: ["process-qualified"], outcomes: { planned: "planned" }, roles: ["planner"], requires: { actions: [], evidence: [], freshAuthority: false, unit: false }, distinctActorFrom: [], distinctOrganizationFrom: [] },
      { id: "authorize-manufacture", kind: "authorization", description: "Manufacturing authority issues a bounded Change Implementation Plan", from: ["planned"], outcomes: { issued: "authorized" }, roles: ["manufacturing-authority"], requires: { actions: [{ id: "record-source-release" }, { id: "approve-requirements" }], evidence: [], freshAuthority: true, unit: false }, distinctActorFrom: ["plan-build"], distinctOrganizationFrom: [] },
      { id: "enter-queue", kind: "queue-entry", description: "Job enters the manual build queue", from: ["authorized"], outcomes: { queued: "queued" }, roles: ["planner", "operator"], requires: { actions: [], evidence: ["build-file"], authorization: "queue", freshAuthority: false, unit: true }, distinctActorFrom: [], distinctOrganizationFrom: [] },
      { id: "dispatch-build", kind: "build-start", description: "Operator dispatches the job to the printer by hand", from: ["queued"], outcomes: { started: "building" }, roles: ["operator"], requires: { actions: [], evidence: [], authorization: "build", freshAuthority: true, unit: true }, distinctActorFrom: [], distinctOrganizationFrom: [] },
      { id: "complete-build", kind: "build-complete", description: "Operator records the build outcome and errors", from: ["building"], outcomes: { completed: "built", failed: "authorized" }, roles: ["operator"], requires: { actions: [], evidence: ["build-log"], authorization: "build", freshAuthority: false, unit: true }, distinctActorFrom: [], distinctOrganizationFrom: [] },
      { id: "inspect", kind: "inspection", description: "Independent inspector records measurements; the decision rules give the outcome", from: ["built", "inspection-held"], outcomes: { accept: "inspected", reject: "inspection-rejected", indeterminate: "inspection-held" }, roles: ["inspector"], requires: { actions: [], evidence: ["measurement-data"], freshAuthority: false, unit: true }, distinctActorFrom: ["dispatch-build", "complete-build"], distinctOrganizationFrom: ["complete-build"] },
      { id: "raise-nonconformance", kind: "nonconformance", description: "Inspector or quality raises an NCR against a rejected or held inspection", from: ["inspection-rejected", "inspection-held"], outcomes: { raised: "nonconforming" }, roles: ["inspector", "quality-engineer"], requires: { actions: [], evidence: [], freshAuthority: false, unit: true }, distinctActorFrom: [], distinctOrganizationFrom: [] },
      { id: "disposition", kind: "disposition", description: "Disposition authority decides; measurement outcome alone never dispositions", from: ["inspected", "nonconforming"], outcomes: { accept: "dispositioned", "use-as-is": "dispositioned", rework: "authorized", scrap: "scrapped" }, roles: ["disposition-authority"], requires: { actions: [], evidence: [], freshAuthority: true, unit: true }, distinctActorFrom: ["inspect"], distinctOrganizationFrom: [] },
      { id: "close-evidence", kind: "closure", description: "Configuration manager closes the evidence set (and records incorporation)", from: ["dispositioned", "scrapped"], outcomes: { closed: "closed" }, roles: ["configuration-manager"], requires: { actions: [], evidence: [], freshAuthority: false, unit: true }, distinctActorFrom: [], distinctOrganizationFrom: [] },
    ],
  };
}

/** Second configuration, same engine: first-article process with two independent inspections, no queue, quality-engineer disposition, no suitability gap acceptance. */
export function firstArticleProcess(): ProcessDefinition {
  const none = { actions: [], evidence: [], freshAuthority: false, unit: false };
  return {
    schema: "tdp-process/0.1",
    id: "printed-part-fai",
    version: 1,
    title: "Printed part: first-article inspection variant",
    label: "Second laboratory configuration (synthetic): dual independent inspection, no queue, no gap acceptance",
    synthetic: true,
    roles: roleList(["requirement-owner", "configuration-manager", "manufacturing-engineer", "planner", "manufacturing-authority", "operator", "inspector", "quality-engineer"]),
    states: ["received", "approved", "released", "qualified", "planned", "authorized", "building", "built", "first-inspected", "fai-verified", "held", "rejected", "nonconforming", "accepted", "scrapped", "closed"],
    initial: "received",
    terminal: ["closed"],
    operations: ["build"],
    allowDelegation: false,
    transitions: [
      { id: "approve-requirements", kind: "requirements-approval", description: "Requirement owner approves", from: ["received"], outcomes: { approved: "approved" }, roles: ["requirement-owner"], requires: none, distinctActorFrom: [], distinctOrganizationFrom: [] },
      { id: "record-source-release", kind: "source-release", description: "Source release evidence", from: ["approved"], outcomes: { verified: "released" }, roles: ["configuration-manager"], requires: { ...none, evidence: ["source-release-record"] }, distinctActorFrom: [], distinctOrganizationFrom: [] },
      { id: "qualify-process", kind: "suitability", description: "Suitability must be clean: gaps send it back, there is no gap acceptance in this variant", from: ["released"], outcomes: { suitable: "qualified", "review-required": "released", "not-suitable": "released" }, roles: ["manufacturing-engineer"], requires: { ...none, evidence: ["capability-study", "calibration-certificate"] }, distinctActorFrom: [], distinctOrganizationFrom: [] },
      { id: "plan-first-article", kind: "plan", description: "First-article plan", from: ["qualified"], outcomes: { planned: "planned" }, roles: ["planner"], requires: none, distinctActorFrom: [], distinctOrganizationFrom: [] },
      { id: "authorize-first-article", kind: "authorization", description: "One-unit authorization", from: ["planned"], outcomes: { issued: "authorized" }, roles: ["manufacturing-authority"], requires: { ...none, freshAuthority: true }, distinctActorFrom: ["plan-first-article"], distinctOrganizationFrom: [] },
      { id: "build", kind: "build-start", description: "Operator starts the build (no queue in this variant)", from: ["authorized"], outcomes: { started: "building" }, roles: ["operator"], requires: { ...none, authorization: "build", unit: true, freshAuthority: true }, distinctActorFrom: [], distinctOrganizationFrom: [] },
      { id: "finish", kind: "build-complete", description: "Build outcome", from: ["building"], outcomes: { completed: "built", failed: "scrapped" }, roles: ["operator"], requires: { ...none, evidence: ["build-log"], authorization: "build", unit: true }, distinctActorFrom: [], distinctOrganizationFrom: [] },
      { id: "first-inspection", kind: "inspection", description: "First inspection", from: ["built"], outcomes: { accept: "first-inspected", reject: "rejected", indeterminate: "held" }, roles: ["inspector"], requires: { ...none, evidence: ["measurement-data"], unit: true }, distinctActorFrom: ["build", "finish"], distinctOrganizationFrom: ["finish"] },
      { id: "second-inspection", kind: "inspection", description: "Second, independent inspection", from: ["first-inspected"], outcomes: { accept: "fai-verified", reject: "rejected", indeterminate: "held" }, roles: ["inspector"], requires: { ...none, evidence: ["measurement-data"], unit: true }, distinctActorFrom: ["first-inspection", "build", "finish"], distinctOrganizationFrom: ["finish"] },
      { id: "raise-nonconformance", kind: "nonconformance", description: "NCR", from: ["rejected", "held"], outcomes: { raised: "nonconforming" }, roles: ["quality-engineer"], requires: { ...none, unit: true }, distinctActorFrom: [], distinctOrganizationFrom: [] },
      { id: "fai-disposition", kind: "disposition", description: "Quality engineer dispositions the first article", from: ["fai-verified", "nonconforming"], outcomes: { accept: "accepted", "use-as-is": "accepted", scrap: "scrapped" }, roles: ["quality-engineer"], requires: { ...none, unit: true, freshAuthority: true, actions: [{ id: "second-inspection" }] }, distinctActorFrom: ["first-inspection", "second-inspection"], distinctOrganizationFrom: [] },
      { id: "close", kind: "closure", description: "Close", from: ["accepted", "scrapped"], outcomes: { closed: "closed" }, roles: ["configuration-manager"], requires: { ...none, unit: true }, distinctActorFrom: [], distinctOrganizationFrom: [] },
    ],
  };
}

export const processBytes = (p: ProcessDefinition) => utf8.encode(JSON.stringify(p, null, 2) + "\n");

// ---- World: keys, trust store, authority ----

export interface LabWorld {
  keys: Record<string, DemoKey>;
  root: DemoKey & { name: string };
  anchors: Anchors;
  trustStore: TrustStore;
  signedTrustStore: unknown;
  processes: { definition: ProcessDefinition; bytes: Uint8Array }[];
  authority: AuthorityConfig;
  authorityBytes: Uint8Array;
  signedAuthority: unknown;
}

export async function buildWorld(opts: { processes?: ProcessDefinition[]; authorityPatch?: (a: AuthorityConfig) => AuthorityConfig } = {}): Promise<LabWorld> {
  const keys: Record<string, DemoKey> = {};
  for (const p of PEOPLE) keys[p.id] = await demoKey(p.id);
  const root = { ...(await demoKey("lab-root")), name: "Lab Authority Root (demo key, public seed)" };
  const anchors: Anchors = { schema: "tdp-anchors/0.1", roots: [{ keyId: root.keyId, name: root.name, publicKey: root.publicKey }] };
  const trustStore: TrustStore = {
    schema: "tdp-truststore/0.1",
    keys: PEOPLE.map((p) => ({
      keyId: keys[p.id]!.keyId, name: p.name, organization: { name: p.org }, publicKey: keys[p.id]!.publicKey,
      roles: p.signing, notBefore: iso(-24 * 60), notAfter: "2028-11-10T00:00:00.000Z", revoked: false,
    })),
  };
  const signedTrustStore = await signTrustStore(trustStore, root, { serial: 1, validDays: 730, now: at(-120) });
  const processes = (opts.processes ?? [printedPartProcess(), firstArticleProcess()]).map((definition) => ({ definition, bytes: processBytes(definition) }));
  let authority: AuthorityConfig = {
    schema: "tdp-authority/0.1",
    id: "lab-authority",
    serial: 1,
    issuer: root.name,
    issued: iso(-60),
    expires: "2027-11-10T00:00:00.000Z",
    fixture: true,
    label: "LOCAL LABORATORY AUTHORITY FIXTURE: stands in for the source PLM's release authority and the program's role assignments. Not Onshape, not Windchill.",
    offlineValidityHours: 168,
    organizations: Object.values(ORG).map((name) => ({ name })),
    sources: [
      { id: "lab-fixture-plm", system: "lab-fixture", label: "Laboratory fixture PLM (synthetic)", authoritativeFor: [PART, ASSY], integration: "file-exchange", releasedStates: ["Released"], acknowledgementKeys: [keys["source-plm"]!.keyId] },
    ],
    processes: await Promise.all(processes.map(async (p) => ({ id: p.definition.id, version: p.definition.version, sha256: await sha256Hex(p.bytes) }))),
    grants: PEOPLE.filter((p) => p.workflow.length).map((p) => ({
      keyId: keys[p.id]!.keyId, organization: p.org, roles: p.workflow, processes: p.processes ?? processes.map((x) => x.definition.id),
      mayDelegate: !!p.mayDelegate, notBefore: iso(-24 * 60), notAfter: "2027-11-10T00:00:00.000Z",
    })),
    revokedKeys: [{ keyId: keys["revoked-op"]!.keyId, reason: "demo: credential withdrawn after badge loss (synthetic)" }],
  };
  if (opts.authorityPatch) authority = opts.authorityPatch(authority);
  const authorityBytes = utf8.encode(JSON.stringify(authority, null, 2) + "\n");
  const signedAuthority = await signConfig("tdp-authority/0.1", authorityBytes, root, at(-60));
  return { keys, root, anchors, trustStore, signedTrustStore, processes, authority, authorityBytes, signedAuthority };
}

// ---- Synthetic evidence ----

export interface EvidenceFile {
  name: string;
  bytes: Uint8Array;
  tag: string;
  mediaType: string;
  description: string;
}

const synthetic = (title: string, body: string) => utf8.encode(`SYNTHETIC DEMONSTRATION EVIDENCE - NOT A REAL ${title.toUpperCase()}\n${SYNTHETIC}\n\n${body}\n`);

export function labEvidence(): Record<string, EvidenceFile> {
  const files: EvidenceFile[] = [
    { name: "source-release-SYN-PH-2001-A.json", tag: "source-release-record", mediaType: "application/json", description: "Laboratory fixture PLM release record export (synthetic)", bytes: synthetic("release record", JSON.stringify({ system: "lab-fixture", item: PART, revision: "A", state: "Released", releaseId: "SYNTH-REL-0001" }, null, 2)) },
    { name: "capability-study-H2C-PETG.txt", tag: "capability-study", mediaType: "text/plain", description: "Dimensional capability study, general claim (synthetic)", bytes: synthetic("capability study", "Resource: H2C-LAB-01 (synthetic)\nMaterial: PETG\nClaimed general dimensional capability: +/-0.15 mm at k=2 over 30 coupons (INVENTED)") },
    { name: "printer-calibration-H2C-LAB-01.txt", tag: "calibration-certificate", mediaType: "text/plain", description: "Printer calibration record (synthetic)", bytes: synthetic("calibration record", "Printer H2C-LAB-01: bed level, flow and XY skew calibrated (INVENTED)") },
    { name: "micrometer-MIC-07-cal.txt", tag: "calibration-certificate", mediaType: "text/plain", description: "Micrometer MIC-07 calibration certificate (synthetic)", bytes: synthetic("calibration certificate", "Instrument MIC-07 0-25 mm outside micrometer; due 2027-06-01 (INVENTED)") },
    { name: "caliper-CAL-12-cal.txt", tag: "calibration-certificate", mediaType: "text/plain", description: "Caliper CAL-12 calibration certificate (synthetic)", bytes: synthetic("calibration certificate", "Instrument CAL-12 0-150 mm digital caliper; due 2027-03-01 (INVENTED)") },
    { name: "job-J-0001.txt", tag: "build-file", mediaType: "text/plain", description: "Placeholder for the sliced job file of J-0001 (synthetic; not a real .gcode.3mf)", bytes: synthetic("sliced job", "Job J-0001 placeholder. A real run would attach the exact .gcode.3mf submitted to the printer.") },
    { name: "job-J-0002.txt", tag: "build-file", mediaType: "text/plain", description: "Placeholder for the sliced job file of J-0002 (synthetic)", bytes: synthetic("sliced job", "Job J-0002 placeholder (re-sliced with a brim after the J-0001 failure).") },
    { name: "build-log-J-0001.txt", tag: "build-log", mediaType: "text/plain", description: "Build log for failed job J-0001 (synthetic)", bytes: synthetic("build log", "J-0001: first-layer adhesion failure at layer 3; operator stopped the job (INVENTED)") },
    { name: "build-log-J-0002.txt", tag: "build-log", mediaType: "text/plain", description: "Build log for job J-0002 (synthetic)", bytes: synthetic("build log", "J-0002: completed, 41 min, no errors (INVENTED)") },
    { name: "measurements-SN-0001.csv", tag: "measurement-data", mediaType: "text/csv", description: "Measurement data SN-0001 (synthetic)", bytes: synthetic("measurement sheet", "characteristic,value,unit\nCH-001,6.04,mm\nCH-002,40.12,mm\nCH-003,19.88,mm") },
    { name: "measurements-SN-0002.csv", tag: "measurement-data", mediaType: "text/csv", description: "Measurement data SN-0002 (synthetic)", bytes: synthetic("measurement sheet", "characteristic,value,unit\nCH-001,6.25,mm\nCH-002,40.05,mm\nCH-003,19.95,mm") },
    { name: "measurements-SN-0003.csv", tag: "measurement-data", mediaType: "text/csv", description: "Measurement data SN-0003 (synthetic)", bytes: synthetic("measurement sheet", "characteristic,value,unit\nCH-001,6.198,mm\nCH-002,40.01,mm\nCH-003,20.02,mm") },
    { name: "job-J-0101.txt", tag: "build-file", mediaType: "text/plain", description: "Placeholder job file J-0101 (synthetic)", bytes: synthetic("sliced job", "Job J-0101 placeholder.") },
    { name: "build-log-J-0101.txt", tag: "build-log", mediaType: "text/plain", description: "Build log J-0101 (synthetic)", bytes: synthetic("build log", "J-0101: completed (INVENTED)") },
  ];
  return Object.fromEntries(files.map((f) => [f.name, f]));
}

let evidenceCounter = 0;
/** Evidence reference for a file, with a short id unique within a record. */
export async function ref(f: EvidenceFile, id?: string): Promise<EvidenceRef> {
  return { id: id ?? `EV-${++evidenceCounter}`, tag: f.tag, sha256: await sha256Hex(f.bytes), mediaType: f.mediaType, description: f.description, synthetic: true };
}

/**
 * Appends a record WITHOUT the gate: signs whatever it's given. Only for building deliberately
 * invalid demonstration ledgers, to show the verifier rejects what a careful CLI would refuse.
 */
export async function forceAppend(ledger: LedgerFile, signer: DemoKey, record: Record<string, unknown>): Promise<LedgerFile> {
  const sha = await canonicalSha256(record);
  const sig = await signWith(signer, recordSigningMessage(sha));
  return { ...ledger, entries: [...ledger.entries, { record, signature: { schema: "tdp-record-signature/0.1", recordSha256: sha, keyId: signer.keyId, alg: "Ed25519", sig } }] };
}

export { genesisDigest };
export type { RecordData };

/** Rezips a package with one entry changed (for tamper demonstrations). */
export function rezip(tdp: Uint8Array, edit: (files: Record<string, Uint8Array>) => void): Uint8Array {
  const files = unzipSync(tdp);
  edit(files);
  return zipSync(files);
}
