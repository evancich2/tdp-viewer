// The laboratory demonstration: builds every ledger through the same gate the CLI uses, then runs
// the P01–P08 demonstrations and records expected vs actual for each. Shared by `npm run lab`
// (which writes the results to samples/lab/) and the test suite (which asserts them).
// All data is synthetic (see lab-fixtures.ts). Nothing here represents a physical build.
import { readFileSync } from "node:fs";
import { sha256Hex, utf8 } from "../src/core/bytes";
import { canonicalSha256 } from "../src/core/canonical";
import { loadAuthority, type LoadedAuthority } from "../src/core/authority";
import { checkLedgerAgainstHeads, consistencyProof, findForks, inclusionProof, leavesOf, signTreeHead, verifyConsistency, verifyInclusion, witnessHead, type ConsistencyProofFile, type TreeHead, type Witness } from "../src/core/custody";
import { buildEvidenceBundle, signEvidenceBundle, verifySignedEvidence, type Demonstration, type SignedEvidence } from "../src/core/evidence";
import {
  LocalFixtureAdapter,
  PublishingRecipe,
  buildProposals,
  importAcknowledgements,
  txContentSha256,
  type AckSet,
  type FixtureState,
  type ProposalSet,
} from "../src/core/exchange";
import { evaluateInspection, type Measurement } from "../src/core/inspection";
import { loadProcess, type LoadedProcess } from "../src/core/process";
import { defaultPolicy } from "../src/core/policy";
import { PRINTERS } from "../src/core/printers";
import {
  TransitionDenied,
  appendRecord,
  baselineFrom,
  checkCheckpoint,
  evidenceStoreFrom,
  makeCheckpoint,
  newLedger,
  successorsOf,
  unitLabel,
  verifyLedger,
  workflowStatus,
  type EvidenceStore,
  type LedgerFile,
  type LedgerResult,
  type RecordInput,
  type WorkflowContext,
} from "../src/core/records";
import type { TrustStore } from "../src/core/schema";
import { loadTrustStoreFile } from "../src/core/truststore";
import { verifyPackage, type VerifyResult } from "../src/core/verify";
import {
  ASSY,
  LAB_NOW,
  ORG,
  PART,
  at,
  buildLabPackage,
  buildWorld,
  forceAppend,
  iso,
  labEvidence,
  printedPartProcess,
  processBytes,
  ref,
  rezip,
  uuidFor,
  type EvidenceFile,
  type LabPackage,
  type LabWorld,
} from "./lab-fixtures";

export interface Lab {
  world: LabWorld;
  trustStore: TrustStore;
  authority: LoadedAuthority;
  processes: Record<string, LoadedProcess>;
  revA: LabPackage & { result: VerifyResult };
  revB: LabPackage & { result: VerifyResult };
  evidence: Record<string, EvidenceFile>;
  store: EvidenceStore;
  ctx: (processId: string, pkg: { result: VerifyResult }, now?: Date, store?: EvidenceStore | null) => WorkflowContext;
  ledgers: Record<string, LedgerFile>;
}

export async function setupLab(): Promise<Lab> {
  const world = await buildWorld();
  const { store: trustStore } = await loadTrustStoreFile(JSON.stringify(world.signedTrustStore), { anchors: world.anchors, now: LAB_NOW });
  const authority = await loadAuthority(JSON.stringify(world.signedAuthority), { anchors: world.anchors });
  const processes: Record<string, LoadedProcess> = {};
  for (const p of world.processes) processes[p.definition.id] = await loadProcess(utf8.decode(p.bytes));
  const a = await buildLabPackage("A", world.keys.author!, world.keys.approver!);
  const aResult = await verifyPackage(a.tdp, trustStore, defaultPolicy, LAB_NOW);
  const b = await buildLabPackage("B", world.keys.author!, world.keys.approver!, { packageId: a.packageId, manifestSha256: aResult.manifestSha256!, baselineId: a.model.baseline.id });
  const bResult = await verifyPackage(b.tdp, trustStore, defaultPolicy, LAB_NOW);
  const evidence = labEvidence();
  const store = await evidenceStoreFrom(Object.values(evidence).map((f) => ({ name: f.name, bytes: f.bytes })));
  const ctx: Lab["ctx"] = (processId, pkg, now = LAB_NOW, s) => ({
    baseline: baselineFrom(pkg.result),
    authority,
    process: processes[processId]!,
    trustStore,
    now,
    skewMs: defaultPolicy.clockSkewMs,
    ...(s === null ? {} : { evidence: s ?? store }),
  });
  return { world, trustStore, authority, processes, revA: { ...a, result: aResult }, revB: { ...b, result: bResult }, evidence, store, ctx, ledgers: {} };
}

const E = (lab: Lab, name: string, id?: string) => ref(lab.evidence[name]!, id);
/** The firmware the lab's H2C actually runs (real, not synthetic): taken from the printer profile. */
const H2C_FIRMWARE = PRINTERS.find((p) => p.id === "bambu-h2c")!.firmware!;

/** One step through the gate, at scenario minute `m`. */
async function step(lab: Lab, name: string, ledger: LedgerFile, processId: string, pkg: { result: VerifyResult }, who: string, m: number, input: RecordInput): Promise<LedgerFile> {
  const ctx = lab.ctx(processId, pkg, at(m));
  const seq = ledger.entries.length + 1;
  return (await appendRecord(ledger, ctx, lab.world.keys[who]!, input, { recordId: await uuidFor(`${name}/${seq}`) })).ledger;
}

const measurementsFor = (values: [number, number, number], instruments = { mic: "EV-MIC", cal: "EV-CAL" }, m: number): Measurement[] => {
  const mic = { id: "MIC-07", description: "0-25 mm outside micrometer (synthetic)", calibrationEvidence: instruments.mic, calibrationValidUntil: "2027-06-01T00:00:00.000Z" };
  const cal = { id: "CAL-12", description: "0-150 mm digital caliper (synthetic)", calibrationEvidence: instruments.cal, calibrationValidUntil: "2027-03-01T00:00:00.000Z" };
  const u = (expanded: number) => ({ expanded, k: 2, unit: "mm" as const, basis: "synthetic uncertainty budget: instrument spec + repeatability (INVENTED)" });
  return [
    { characteristic: "CH-001", value: values[0], unit: "mm", method: "two-point micrometer, 3 readings averaged", instrument: mic, uncertainty: u(0.004), measuredAt: iso(m) },
    { characteristic: "CH-002", value: values[1], unit: "mm", method: "caliper, overall length", instrument: cal, uncertainty: u(0.03), measuredAt: iso(m) },
    { characteristic: "CH-003", value: values[2], unit: "mm", method: "caliper, hook height", instrument: cal, uncertainty: u(0.03), measuredAt: iso(m) },
  ];
};

/** Steps 1–6 of the reference process for one unit: approvals, release evidence, suitability, plan, authorization. */
async function prelude(lab: Lab, name: string, pkg: LabPackage & { result: VerifyResult }, serials: string[], opts: { firmware?: string | null; process?: string; geometryReview?: { link: string; resolution: string }[]; offset?: number; limits?: { transition: string; max: number }[] } = {}) {
  const processId = opts.process ?? "printed-part";
  const o = opts.offset ?? 0;
  const fai = processId === "printed-part-fai";
  const ctx0 = lab.ctx(processId, pkg, at(o));
  let L = newLedger(ctx0, { itemId: PART, revision: pkg.revision }, await uuidFor(`instance/${name}`));
  const s = (who: string, m: number, input: RecordInput) => step(lab, name, L, processId, pkg, who, m + o, input).then((x) => (L = x));
  await s("req-owner", 0, { action: "approve-requirements", role: "requirement-owner", outcome: "approved", reason: "Requirement set reviewed against the surrogate design intent (synthetic)", data: { kind: "requirements-approval", requirements: [{ id: "REQ-001", version: 1 }, { id: "REQ-002", version: 1 }, { id: "REQ-003", version: 1 }] } });
  const src = pkg.model.sources.find((x) => x.id === `SRC-${PART}`)!;
  await s("config-mgr", 10, { action: "record-source-release", role: "configuration-manager", outcome: "verified", reason: "Release record exported from the laboratory fixture PLM (synthetic)", data: { kind: "source-release", source: src.id, system: "lab-fixture", reference: src.reference, revision: pkg.revision, releaseState: "Released", attestation: "lab-fixture" }, evidence: [await E(lab, "source-release-SYN-PH-2001-A.json", "EV-REL")] });
  const firmware = opts.firmware === undefined ? null : opts.firmware;
  const input = {
    resource: { id: "H2C-LAB-01", model: "Bambu Lab H2C", serial: "SYNTH-H2C-0001", firmware, buildVolumeMm: [300, 320, 320] as [number, number, number] },
    material: { name: "PETG", lot: "SYNTH-LOT-PETG-07" },
    profile: { name: "PETG 0.20 mm lab profile (synthetic)" },
    orientation: "tab face down, long axis along X",
    scope: "SYN-PH-2001 only: planar prismatic features, ±0.2 mm class tolerances",
    capabilities: [{ appliesTo: "*", deviation: 0.15, unit: "mm" as const, basis: "synthetic capability study, 30 coupons, k=2 (INVENTED)", evidence: "EV-CAP", validUntil: "2027-05-01T00:00:00.000Z" }],
    calibration: [{ what: "printer H2C-LAB-01", evidence: "EV-PCAL", validUntil: "2026-12-31T00:00:00.000Z" }],
    declaredGaps: [],
  };
  const suitEvidence = [await E(lab, "capability-study-H2C-PETG.txt", "EV-CAP"), await E(lab, "printer-calibration-H2C-LAB-01.txt", "EV-PCAL")];
  const outcome = firmware ? "suitable" : "review-required";
  await s("mfg-eng", 30, { action: fai ? "qualify-process" : "review-suitability", role: "manufacturing-engineer", outcome, reason: "Suitability reviewed against REQ-001..003 (synthetic)", data: { kind: "suitability", input }, evidence: suitEvidence });
  if (!firmware) {
    const suitId = await uuidFor(`${name}/3`);
    await s("design-eng", 45, { action: "engineering-gap-review", role: "design-engineer", outcome: "accepted", reason: "Firmware not read from the machine; accepted for a laboratory build only (synthetic)", data: { kind: "suitability-review", suitabilityRecord: suitId, acceptedGaps: ["printer firmware not recorded"], rationale: "Lab-only build; firmware to be recorded before any further use (synthetic)" } });
  }
  await s("planner", 60, {
    action: fai ? "plan-first-article" : "plan-build", role: "planner", outcome: "planned", reason: "Build and inspection plan (synthetic)",
    data: { kind: "plan", buildPlanId: `BP-${name}`, settings: { layerHeight: "0.20", infill: "40%", nozzle: "0.4", plate: "textured PEI" }, inspectionPlan: [{ characteristic: "CH-001", method: "micrometer", instrumentClass: "0-25 mm micrometer" }, { characteristic: "CH-002", method: "caliper", instrumentClass: "0-150 mm caliper" }, { characteristic: "CH-003", method: "caliper", instrumentClass: "0-150 mm caliper" }], geometryReview: opts.geometryReview ?? [] },
  });
  await s("mfg-authority", 90, {
    action: fai ? "authorize-first-article" : "authorize-manufacture", role: "manufacturing-authority", outcome: "issued", reason: "Bounded CIP for laboratory build of the listed units (synthetic)",
    data: { kind: "authorization", cipId: `CIP-${name}`, operations: fai ? ["build"] : ["queue", "build"], organizations: [ORG.cell], roles: ["planner", "operator"], units: { serials }, notBefore: iso(90 + o), notAfter: iso(90 + o + 14 * 24 * 60), policyVersion: 1, ...(opts.limits ? { limits: opts.limits } : {}) },
  });
  return { get: () => L, s };
}

export async function buildLedgers(lab: Lab): Promise<void> {
  const ev = (n: string, id: string) => E(lab, n, id);
  const sn = (serial: string) => ({ serial });

  // SN-0001: full path, including a failed build, a delegation, acceptance and closure.
  {
    const p = await prelude(lab, "SN-0001", lab.revA, ["SN-0001", "SN-0002", "SN-0003"], { limits: [{ transition: "dispatch-build", max: 2 }] });
    const { s } = p;
    await s("planner", 100, { action: "enter-queue", role: "planner", outcome: "queued", unit: sn("SN-0001"), reason: "Queued by hand (manual queue)", data: { kind: "queue-entry", jobId: "J-0001", submittedFile: { name: "job-J-0001.txt", sha256: await sha256Hex(lab.evidence["job-J-0001.txt"]!.bytes) }, settings: { profile: "PETG 0.20 mm lab profile (synthetic)" } }, evidence: [await ev("job-J-0001.txt", "EV-JOB")] });
    await s("operator", 110, { action: "dispatch-build", role: "operator", outcome: "started", unit: sn("SN-0001"), reason: "Sent to H2C-LAB-01 from Bambu Studio by hand", data: { kind: "build-start", jobId: "J-0001", resource: "H2C-LAB-01", startedAt: iso(110) } });
    await s("operator", 140, { action: "complete-build", role: "operator", outcome: "failed", unit: sn("SN-0001"), reason: "Stopped after adhesion failure (synthetic)", data: { kind: "build-complete", jobId: "J-0001", submittedFileSha256: await sha256Hex(lab.evidence["job-J-0001.txt"]!.bytes), startedAt: iso(110), completedAt: iso(138), errors: ["first-layer adhesion failure at layer 3 (synthetic)"], settings: { profile: "PETG 0.20 mm lab profile (synthetic)" } }, evidence: [await ev("build-log-J-0001.txt", "EV-LOG")] });
    await s("operator", 150, { action: "enter-queue", role: "operator", outcome: "queued", unit: sn("SN-0001"), reason: "Re-sliced with a brim and requeued under the same CIP", data: { kind: "queue-entry", jobId: "J-0002", submittedFile: { name: "job-J-0002.txt", sha256: await sha256Hex(lab.evidence["job-J-0002.txt"]!.bytes) }, settings: { profile: "PETG 0.20 mm lab profile + brim (synthetic)" } }, evidence: [await ev("job-J-0002.txt", "EV-JOB")] });
    await s("cell-lead", 155, { action: "delegate", role: "operator", outcome: "issued", reason: "Second-shift cover (synthetic)", data: { kind: "delegation", subject: lab.world.keys.operator2!.keyId, organization: ORG.cell, role: "operator", processes: ["printed-part"], notBefore: iso(155), notAfter: iso(155 + 12 * 60) } });
    await s("operator2", 160, { action: "dispatch-build", role: "operator", outcome: "started", unit: sn("SN-0001"), reason: "Dispatched by hand under delegation", data: { kind: "build-start", jobId: "J-0002", resource: "H2C-LAB-01", startedAt: iso(160) } });
    await s("operator2", 205, { action: "complete-build", role: "operator", outcome: "completed", unit: sn("SN-0001"), reason: "Completed (synthetic)", data: { kind: "build-complete", jobId: "J-0002", submittedFileSha256: await sha256Hex(lab.evidence["job-J-0002.txt"]!.bytes), startedAt: iso(160), completedAt: iso(201), errors: [], settings: { profile: "PETG 0.20 mm lab profile + brim (synthetic)" } }, evidence: [await ev("build-log-J-0002.txt", "EV-LOG")] });
    await s("inspector", 300, { action: "inspect", role: "inspector", outcome: "accept", unit: sn("SN-0001"), reason: "Measured per plan (synthetic values)", data: { kind: "inspection", decisionRules: "core/decision-rules/0.1", measurements: measurementsFor([6.04, 40.12, 19.88], undefined, 300) }, evidence: [await ev("measurements-SN-0001.csv", "EV-MEAS"), await ev("micrometer-MIC-07-cal.txt", "EV-MIC"), await ev("caliper-CAL-12-cal.txt", "EV-CAL")] });
    const inspId = await uuidFor("SN-0001/14");
    await s("mrb", 330, { action: "disposition", role: "disposition-authority", outcome: "accept", unit: sn("SN-0001"), reason: "Conforming; accepted for laboratory use (synthetic)", data: { kind: "disposition", inspectionRecord: inspId, rationale: "All characteristics accepted under the guard-banded and simple-acceptance rules" } });
    await s("config-mgr", 360, { action: "close-evidence", role: "configuration-manager", outcome: "closed", unit: sn("SN-0001"), reason: "Evidence set complete; fitted as the left latch", data: { kind: "closure", incorporation: { occurrence: "OCC-2000-LATCH-L", parentUnit: "SYNTH-ASSY-0001" }, summary: "SN-0001 built (second attempt), inspected, accepted and incorporated (synthetic)" } });
    lab.ledgers["SN-0001"] = p.get();
  }

  // SN-0002: rejected characteristic → NCR → scrap → closure.
  {
    const p = await prelude(lab, "SN-0002", lab.revA, ["SN-0002"]);
    const { s } = p;
    const job = lab.evidence["job-J-0101.txt"]!;
    await s("planner", 100, { action: "enter-queue", role: "planner", outcome: "queued", unit: sn("SN-0002"), reason: "Queued", data: { kind: "queue-entry", jobId: "J-0101", submittedFile: { name: job.name, sha256: await sha256Hex(job.bytes) }, settings: { profile: "PETG 0.20 mm lab profile (synthetic)" } }, evidence: [await ev(job.name, "EV-JOB")] });
    await s("operator", 110, { action: "dispatch-build", role: "operator", outcome: "started", unit: sn("SN-0002"), reason: "Dispatched by hand", data: { kind: "build-start", jobId: "J-0101", resource: "H2C-LAB-01", startedAt: iso(110) } });
    await s("operator", 160, { action: "complete-build", role: "operator", outcome: "completed", unit: sn("SN-0002"), reason: "Completed", data: { kind: "build-complete", jobId: "J-0101", submittedFileSha256: await sha256Hex(job.bytes), startedAt: iso(110), completedAt: iso(155), errors: [], settings: { profile: "PETG 0.20 mm lab profile (synthetic)" } }, evidence: [await ev("build-log-J-0101.txt", "EV-LOG")] });
    await s("inspector", 200, { action: "inspect", role: "inspector", outcome: "reject", unit: sn("SN-0002"), reason: "Measured per plan (synthetic values)", data: { kind: "inspection", decisionRules: "core/decision-rules/0.1", measurements: measurementsFor([6.25, 40.05, 19.95], undefined, 200) }, evidence: [await ev("measurements-SN-0002.csv", "EV-MEAS"), await ev("micrometer-MIC-07-cal.txt", "EV-MIC"), await ev("caliper-CAL-12-cal.txt", "EV-CAL")] });
    const inspId = await uuidFor("SN-0002/10");
    await s("inspector", 210, { action: "raise-nonconformance", role: "inspector", outcome: "raised", unit: sn("SN-0002"), reason: "Tab over maximum", data: { kind: "nonconformance", ncrId: "NCR-0001", inspectionRecord: inspId, characteristics: ["CH-001"], description: "CH-001 tab thickness 6.25 mm exceeds 6.20 mm + U (synthetic)" } });
    await s("mrb", 240, { action: "disposition", role: "disposition-authority", outcome: "scrap", unit: sn("SN-0002"), reason: "Scrap; no use-as-is for a retention feature (synthetic)", data: { kind: "disposition", inspectionRecord: inspId, ncrId: "NCR-0001", rationale: "Oversize tab would bind in the pocket (synthetic)" } });
    await s("config-mgr", 260, { action: "close-evidence", role: "configuration-manager", outcome: "closed", unit: sn("SN-0002"), reason: "Closed as scrapped", data: { kind: "closure", summary: "SN-0002 scrapped under NCR-0001 (synthetic)" } });
    lab.ledgers["SN-0002"] = p.get();
  }

  // SN-0003: indeterminate (within U of a limit) → held.
  {
    const p = await prelude(lab, "SN-0003", lab.revA, ["SN-0003"]);
    const { s } = p;
    const job = lab.evidence["job-J-0101.txt"]!;
    await s("planner", 100, { action: "enter-queue", role: "planner", outcome: "queued", unit: sn("SN-0003"), reason: "Queued", data: { kind: "queue-entry", jobId: "J-0201", submittedFile: { name: job.name, sha256: await sha256Hex(job.bytes) }, settings: {} }, evidence: [await ev(job.name, "EV-JOB")] });
    await s("operator", 110, { action: "dispatch-build", role: "operator", outcome: "started", unit: sn("SN-0003"), reason: "Dispatched by hand", data: { kind: "build-start", jobId: "J-0201", resource: "H2C-LAB-01", startedAt: iso(110) } });
    await s("operator", 160, { action: "complete-build", role: "operator", outcome: "completed", unit: sn("SN-0003"), reason: "Completed", data: { kind: "build-complete", jobId: "J-0201", submittedFileSha256: await sha256Hex(job.bytes), startedAt: iso(110), completedAt: iso(155), errors: [], settings: {} }, evidence: [await ev("build-log-J-0101.txt", "EV-LOG")] });
    await s("inspector", 200, { action: "inspect", role: "inspector", outcome: "indeterminate", unit: sn("SN-0003"), reason: "Measured per plan (synthetic values)", data: { kind: "inspection", decisionRules: "core/decision-rules/0.1", measurements: measurementsFor([6.198, 40.01, 20.02], undefined, 200) }, evidence: [await ev("measurements-SN-0003.csv", "EV-MEAS"), await ev("micrometer-MIC-07-cal.txt", "EV-MIC"), await ev("caliper-CAL-12-cal.txt", "EV-CAL")] });
    lab.ledgers["SN-0003"] = p.get();
  }

  // A lot of two serials in one ledger: shared approvals and CIP, then each unit on its own track.
  {
    const p = await prelude(lab, "LOT-0004", lab.revA, ["SN-0004", "SN-0005"]);
    const { s } = p;
    const job = lab.evidence["job-J-0101.txt"]!;
    const jobSha = await sha256Hex(job.bytes);
    for (const [i, serial] of (["SN-0004", "SN-0005"] as const).entries()) {
      const jobId = `J-04${i}1`;
      await s("planner", 100 + i, { action: "enter-queue", role: "planner", outcome: "queued", unit: sn(serial), reason: "Queued (plate shared by two units)", data: { kind: "queue-entry", jobId, submittedFile: { name: job.name, sha256: jobSha }, settings: {} }, evidence: [await ev(job.name, "EV-JOB")] });
    }
    for (const [i, serial] of (["SN-0004", "SN-0005"] as const).entries())
      await s("operator", 110 + i, { action: "dispatch-build", role: "operator", outcome: "started", unit: sn(serial), reason: "Dispatched by hand", data: { kind: "build-start", jobId: `J-04${i}1`, resource: "H2C-LAB-01", startedAt: iso(110 + i) } });
    for (const [i, serial] of (["SN-0004", "SN-0005"] as const).entries()) {
      const jobId = `J-04${i}1`;
      await s("operator", 160 + i, { action: "complete-build", role: "operator", outcome: "completed", unit: sn(serial), reason: "Completed", data: { kind: "build-complete", jobId, submittedFileSha256: jobSha, startedAt: iso(110 + i), completedAt: iso(158), errors: [], settings: {} }, evidence: [await ev("build-log-J-0101.txt", "EV-LOG")] });
    }
    const insEv = async (csv: string) => [await ev(csv, "EV-MEAS"), await ev("micrometer-MIC-07-cal.txt", "EV-MIC"), await ev("caliper-CAL-12-cal.txt", "EV-CAL")];
    await s("inspector", 200, { action: "inspect", role: "inspector", outcome: "accept", unit: sn("SN-0004"), reason: "Measured (synthetic values)", data: { kind: "inspection", decisionRules: "core/decision-rules/0.1", measurements: measurementsFor([6.03, 40.02, 19.97], undefined, 200) }, evidence: await insEv("measurements-SN-0001.csv") });
    await s("inspector", 205, { action: "inspect", role: "inspector", outcome: "reject", unit: sn("SN-0005"), reason: "Measured (synthetic values)", data: { kind: "inspection", decisionRules: "core/decision-rules/0.1", measurements: measurementsFor([6.25, 40.05, 19.95], undefined, 205) }, evidence: await insEv("measurements-SN-0002.csv") });
    const inspOf = async (n: number) => uuidFor(`LOT-0004/${n}`);
    // Records: 1–6 prelude, 7–8 queue, 9–10 dispatch, 11–12 complete, 13 inspect SN-0004, 14 inspect SN-0005.
    await s("inspector", 210, { action: "raise-nonconformance", role: "inspector", outcome: "raised", unit: sn("SN-0005"), reason: "Tab over maximum", data: { kind: "nonconformance", ncrId: "NCR-0004", inspectionRecord: await inspOf(14), characteristics: ["CH-001"], description: "CH-001 6.25 mm > 6.20 mm + U (synthetic)" } });
    await s("mrb", 230, { action: "disposition", role: "disposition-authority", outcome: "accept", unit: sn("SN-0004"), reason: "Conforming (synthetic)", data: { kind: "disposition", inspectionRecord: await inspOf(13), rationale: "All characteristics accepted" } });
    await s("mrb", 240, { action: "disposition", role: "disposition-authority", outcome: "scrap", unit: sn("SN-0005"), reason: "Scrap (synthetic)", data: { kind: "disposition", inspectionRecord: await inspOf(14), ncrId: "NCR-0004", rationale: "Oversize tab (synthetic)" } });
    await s("config-mgr", 260, { action: "close-evidence", role: "configuration-manager", outcome: "closed", unit: sn("SN-0004"), reason: "Closed; fitted as the right latch", data: { kind: "closure", incorporation: { occurrence: "OCC-2000-LATCH-R", parentUnit: "SYNTH-ASSY-0001" }, summary: "SN-0004 accepted and incorporated (synthetic)" } });
    lab.ledgers["LOT-0004"] = p.get();
  }

  // Second process configuration, same engine: first-article, two independent inspections.
  {
    const p = await prelude(lab, "FAI-SN-0010", lab.revA, ["SN-0010"], { process: "printed-part-fai", firmware: H2C_FIRMWARE });
    const { s } = p;
    await s("operator", 110, { action: "build", role: "operator", outcome: "started", unit: sn("SN-0010"), reason: "First article dispatched by hand", data: { kind: "build-start", jobId: "J-0301", resource: "H2C-LAB-01", startedAt: iso(110) } });
    await s("operator", 160, { action: "finish", role: "operator", outcome: "completed", unit: sn("SN-0010"), reason: "Completed", data: { kind: "build-complete", jobId: "J-0301", submittedFileSha256: await sha256Hex(lab.evidence["job-J-0101.txt"]!.bytes), startedAt: iso(110), completedAt: iso(158), errors: [], settings: {} }, evidence: [await ev("build-log-J-0101.txt", "EV-LOG")] });
    const meas = async (m: number) => ({ kind: "inspection" as const, decisionRules: "core/decision-rules/0.1" as const, measurements: measurementsFor([6.02, 40.08, 19.93], undefined, m) });
    const insEv = async () => [await ev("measurements-SN-0001.csv", "EV-MEAS"), await ev("micrometer-MIC-07-cal.txt", "EV-MIC"), await ev("caliper-CAL-12-cal.txt", "EV-CAL")];
    await s("inspector", 200, { action: "first-inspection", role: "inspector", outcome: "accept", unit: sn("SN-0010"), reason: "First inspection (synthetic values)", data: await meas(200), evidence: await insEv() });
    await s("inspector2", 230, { action: "second-inspection", role: "inspector", outcome: "accept", unit: sn("SN-0010"), reason: "Independent second inspection (synthetic values)", data: await meas(230), evidence: await insEv() });
    await s("quality", 260, { action: "fai-disposition", role: "quality-engineer", outcome: "accept", unit: sn("SN-0010"), reason: "First article accepted (synthetic)", data: { kind: "disposition", inspectionRecord: await uuidFor("FAI-SN-0010/9"), rationale: "Two independent inspections accepted" } });
    await s("config-mgr", 280, { action: "close", role: "configuration-manager", outcome: "closed", unit: sn("SN-0010"), reason: "Closed", data: { kind: "closure", summary: "First article SN-0010 accepted (synthetic)" } });
    lab.ledgers["FAI-SN-0010"] = p.get();
  }
}

// ---- Exchange fixtures ----

export async function labRecipe(lab: Lab): Promise<PublishingRecipe> {
  return PublishingRecipe.parse({
    schema: "tdp-recipe/0.1",
    id: "lab-asbuilt",
    version: 1,
    label: "As-built and quality results to the laboratory fixture PLM (synthetic)",
    baseline: { baselineId: lab.revA.model.baseline.id, manifestSha256: lab.revA.result.manifestSha256 },
    includeArtifactClasses: ["cad-model", "drawing"],
    requiredRelationships: ["verifies", "describes"],
    permittedRecordKinds: ["build-complete", "inspection", "nonconformance", "disposition", "suitability", "plan"],
    target: { system: "lab-fixture", adapter: "local-fixture" },
    mappings: [
      { recordKind: "build-complete", objectType: "AsBuiltUnit", key: "unit", fields: { serial: "unit.serial", item: "item.itemId", revision: "item.revision", baselineManifest: "baseline.manifestSha256", jobId: "data.jobId", buildOutcome: "record.outcome", completedAt: "data.completedAt" }, lossy: [], acceptLoss: false, changesDefinition: false },
      { recordKind: "inspection", objectType: "InspectionResult", key: "record", fields: { serial: "unit.serial", item: "item.itemId", revision: "item.revision", outcome: "record.outcome", decisionRules: "data.decisionRules", signedRecord: "record.recordId" }, lossy: [{ field: "data.measurements", reason: "the fixture's InspectionResult has no per-characteristic values, instruments or uncertainty; the signed record stays the authority" }], acceptLoss: true, changesDefinition: false },
      { recordKind: "disposition", objectType: "AsBuiltUnit", key: "unit", fields: { serial: "unit.serial", item: "item.itemId", revision: "item.revision", baselineManifest: "baseline.manifestSha256", disposition: "record.outcome", dispositionedBy: "actor.name" }, lossy: [], acceptLoss: false, changesDefinition: false },
      { recordKind: "nonconformance", objectType: "ChangeRequest", key: "record", fields: { ncr: "data.ncrId", item: "item.itemId", revision: "item.revision", description: "data.description" }, lossy: [], acceptLoss: false, changesDefinition: true },
      { recordKind: "suitability", objectType: "ProcessReview", key: "record", fields: { resource: "data.input.resource.id", outcome: "record.outcome" }, lossy: [{ field: "data.input.capabilities", reason: "capability evidence detail has no target field" }], acceptLoss: false, changesDefinition: false },
      { recordKind: "plan", objectType: "ProcessPlan", key: "record", fields: { plan: "data.buildPlanId" }, lossy: [], acceptLoss: false, changesDefinition: false },
    ],
  });
}

export function fixtureSource(lab: Lab): FixtureState {
  const refFor = (item: string) => lab.revA.model.sources.find((s) => s.id === `SRC-${item}`)!.reference;
  return {
    schema: "tdp-fixture-source/0.1",
    system: "lab-fixture",
    label: "Laboratory fixture PLM (synthetic, file-backed)",
    objectTypes: ["AsBuiltUnit", "InspectionResult", "ChangeRequest", "ProcessReview"],
    sourceItems: {
      [PART]: { revision: "A", releaseState: "Released", reference: refFor(PART) },
      [ASSY]: { revision: "A", releaseState: "Released", reference: refFor(ASSY) },
    },
    // SN-0002 was already entered by hand in the source with different content: our create must conflict.
    objects: { [`AsBuiltUnit/${PART}:SN-0002`]: { version: 1, attributes: { serial: "SN-0002", item: PART, revision: "A", note: "entered manually at the source (synthetic)" }, lastTx: "manual" } },
    transactions: {},
  };
}

// ---- Demonstrations ----

export interface LabRun {
  lab: Lab;
  demonstrations: Demonstration[];
  results: Record<string, LedgerResult>;
  exchange: { recipe: PublishingRecipe; initial: FixtureState; after: FixtureState; proposals: ProposalSet; acks: AckSet; replay: AckSet; proposals2: ProposalSet; acks2: AckSet };
  checkpoint: Awaited<ReturnType<typeof makeCheckpoint>>;
  invalid: Record<string, LedgerFile>;
  performance: { metric: string; value: number; unit: string; note: string }[];
  bundle: ReturnType<typeof buildEvidenceBundle>;
  signedBundle: SignedEvidence;
  custody: { witness: Witness; head8: TreeHead; head16: TreeHead; proof: ConsistencyProofFile; forkHead: TreeHead };
}

const failures = (r: { checks: { status: string; message: string }[] }) => r.checks.filter((c) => c.status === "fail").map((c) => c.message).join("; ");

export async function runLab(opts: { legacySample?: { tdp: Uint8Array; trustJson: string } } = {}): Promise<LabRun> {
  const lab = await setupLab();
  await buildLedgers(lab);
  const demos: Demonstration[] = [];
  const demo = (id: string, scenario: string, expected: string, actual: string, pass: boolean) => demos.push({ id, scenario, expected, actual, pass });
  const denied = async (fn: () => Promise<unknown>): Promise<string> => {
    try { await fn(); return "ALLOWED"; } catch (e) { return e instanceof TransitionDenied ? `DENIED: ${e.message}` : `ERROR: ${(e as Error).message}`; }
  };
  const results: Record<string, LedgerResult> = {};
  for (const [name, L] of Object.entries(lab.ledgers)) results[name] = await verifyLedger(L, lab.ctx(L.instance.processId, lab.revA));
  const k = lab.world.keys;

  // P01 identity and release
  demo("P01-a", "Synthetic surrogate rev A (tdp-manifest/0.2) verifies with its engineering model", "trusted, engineering model consistent", `${lab.revA.result.verdict}; ${lab.revA.result.checks.find((c) => c.id === "engineering")!.message}`, lab.revA.result.verdict === "trusted" && !!lab.revA.result.engineering);
  if (opts.legacySample) {
    const { store } = await loadTrustStoreFile(opts.legacySample.trustJson);
    const r = await verifyPackage(opts.legacySample.tdp, store, defaultPolicy);
    demo("P01-b", "Committed tdp-manifest/0.1 sample still verifies unchanged, with no engineering model inferred", "trusted; no engineering model", `${r.verdict}; ${r.checks.find((c) => c.id === "engineering")?.message}`, r.verdict === "trusted" && !r.engineering);
  }
  {
    const fresh = newLedger(lab.ctx("printed-part", lab.revA), { itemId: PART, revision: "A" }, await uuidFor("instance/P01"));
    const r = await verifyLedger(fresh, lab.ctx("printed-part", lab.revA));
    const st = workflowStatus(r, lab.ctx("printed-part", lab.revA));
    demo("P01-c", "Possessing a trusted package does not authorize manufacture or prove source release", "source release not established; operation not authorized", `${st.sourceRelease.text}; ${st.operation.text}`, st.sourceRelease.level === "none" && st.operation.level !== "ok");
    const st1 = workflowStatus(results["SN-0001"]!, lab.ctx("printed-part", lab.revA));
    demo("P01-d", "Source release evidence recorded by the configuration manager under the lab fixture authority", "source release verified, labeled as laboratory fixture", st1.sourceRelease.text, st1.sourceRelease.level === "ok" && /fixture/.test(st1.sourceRelease.text));
  }
  {
    const before = await sha256Hex(lab.revA.tdp);
    const rA = await verifyLedger(lab.ledgers["SN-0001"]!, lab.ctx("printed-part", lab.revA));
    const rWrong = await verifyLedger(lab.ledgers["SN-0001"]!, lab.ctx("printed-part", lab.revB));
    demo("P01-e", "New baseline rev B supersedes rev A; rev A and its evidence are preserved and still verify", "rev B trusted with supersedes link; rev A bytes unchanged; rev A ledger verified; rev A ledger rejected against rev B", `rev B ${lab.revB.result.verdict}, supersedes ${lab.revB.model.baseline.supersedes?.baselineId}; rev A ${before === (await sha256Hex(lab.revA.tdp)) ? "unchanged" : "CHANGED"}; rev A ledger ${rA.verdict}; against rev B: ${rWrong.verdict} (${failures(rWrong).slice(0, 80)}…)`, lab.revB.result.verdict === "trusted" && rA.verdict === "verified" && rWrong.verdict === "rejected" && /wrong baseline/.test(failures(rWrong)));
  }

  // P02 process and build
  {
    const r = results["SN-0001"]!;
    const suit = r.records.find((v) => v.record.data.kind === "suitability")!;
    const fit = suit.suitability!.checks.find((c) => c.id === "build-volume")!;
    demo("P02-a", "Suitability: build-volume fit passes, but missing firmware is a gap, so the result is review-required (fit alone isn't capability)", "review-required with gap 'printer firmware not recorded'; fit pass", `${suit.record.outcome}; fit ${fit.result}; gaps: ${suit.suitability!.checks.filter((c) => c.result === "gap").map((c) => c.message).join(", ")}`, suit.record.outcome === "review-required" && fit.result === "pass");
    const failed = r.records.find((v) => v.record.data.kind === "build-complete" && v.record.outcome === "failed")!;
    demo("P02-b", "Manual queue/build records: a failed job is recorded with its errors and the unit is requeued under the same CIP", "J-0001 failed with errors; J-0002 completed; state closed", `${failed.record.data.kind === "build-complete" ? failed.record.data.errors.join("; ") : ""}; final state ${r.state}`, r.state === "closed" && r.verdict === "verified");
    const fai = results["FAI-SN-0010"]!.records.find((v) => v.record.data.kind === "suitability")!;
    const fw = fai.suitability!.checks.find((c) => c.id === "firmware")!;
    demo("P02-f", `First-article suitability records the H2C's firmware (${H2C_FIRMWARE}), so firmware is no longer a gap`, `firmware pass: firmware ${H2C_FIRMWARE} recorded; suitable`, `firmware ${fw.result}: ${fw.message}; ${fai.record.outcome}`, fw.result === "pass" && fw.message === `firmware ${H2C_FIRMWARE} recorded` && fai.record.outcome === "suitable");
    const deleg = r.records.find((v) => v.record.action === "dispatch-build" && v.via.startsWith("delegation"));
    demo("P02-c", "Operator authority via a verified delegation from a configured key with mayDelegate", "dispatch by delegated operator verifies", deleg ? `dispatch by ${deleg.key.name} via ${deleg.via.slice(0, 24)}…` : "no delegated dispatch", !!deleg);
  }

  // P03 inspection and disposition
  {
    const st = (n: string) => workflowStatus(results[n]!, lab.ctx("printed-part", lab.revA));
    demo("P03-a", "SN-0001 measured within limits (guard-banded / simple acceptance) → accept; disposition is a separate signed decision", "inspection accepted; dispositioned accept", `${st("SN-0001").inspection.text}; ${st("SN-0001").disposition.text}`, st("SN-0001").inspection.level === "ok" && /accept/.test(st("SN-0001").disposition.text));
    demo("P03-b", "SN-0002 tab 6.25 mm > 6.20 mm + U → reject → NCR → scrap", "rejected; NCR-0001; scrap", `${st("SN-0002").inspection.text}; ${st("SN-0002").disposition.text}; state ${results["SN-0002"]!.state}`, results["SN-0002"]!.state === "closed" && /scrap/.test(st("SN-0002").disposition.text));
    demo("P03-c", "SN-0003 tab 6.198 mm is within U of the upper limit → indeterminate, held (never an automatic pass)", "indeterminate; state inspection-held", `${st("SN-0003").inspection.text}; state ${results["SN-0003"]!.state}`, results["SN-0003"]!.state === "inspection-held");
    const c = lab.revA.model.characteristics[0]!;
    const inch = evaluateInspection([c], [{ characteristic: "CH-001", value: 0.2378, unit: "in", method: "micrometer (inch)", instrument: { id: "MIC-IN", description: "inch micrometer", calibrationEvidence: "EV", calibrationValidUntil: "2027-01-01T00:00:00Z" }, uncertainty: { expanded: 0.0002, k: 2, unit: "in", basis: "synthetic" }, measuredAt: iso(0) }], new Set(["EV"]));
    const deg = evaluateInspection([c], [{ characteristic: "CH-001", value: 6.04, unit: "deg", method: "wrong", instrument: { id: "X", description: "x", calibrationEvidence: "EV", calibrationValidUntil: "2027-01-01T00:00:00Z" }, uncertainty: { expanded: 0.01, k: 2, unit: "deg", basis: "synthetic" }, measuredAt: iso(0) }], new Set(["EV"]));
    const nocal = evaluateInspection([c], [{ characteristic: "CH-001", value: 6.04, unit: "mm", method: "micrometer", instrument: { id: "MIC-07", description: "x" }, uncertainty: { expanded: 0.004, k: 2, unit: "mm", basis: "synthetic" }, measuredAt: iso(0) }], new Set());
    demo("P03-d", "Units, limits and missing evidence: 0.2378 in converts and is accepted; degrees vs mm, or no calibration evidence → indeterminate", "accept; indeterminate; indeterminate", `${inch.outcome} (${inch.results[0]!.value} mm); ${deg.outcome}; ${nocal.outcome}`, inch.outcome === "accept" && deg.outcome === "indeterminate" && nocal.outcome === "indeterminate");
    const r = results["SN-0003"]!;
    const ctx = lab.ctx("printed-part", lab.revA, at(400));
    const accept = await denied(() => appendRecord(lab.ledgers["SN-0003"]!, ctx, k.mrb!, { action: "disposition", role: "disposition-authority", outcome: "accept", unit: { serial: "SN-0003" }, reason: "try", data: { kind: "disposition", inspectionRecord: r.records.at(-1)!.record.recordId, rationale: "try" } }));
    demo("P03-e", "Disposition authority tries to 'accept' a held (indeterminate) inspection directly", "DENIED: a held inspection needs an NCR before any disposition", accept, accept.startsWith("DENIED"));
  }

  // P04 invalid transitions
  const invalid: Record<string, LedgerFile> = {};
  {
    const L = lab.ledgers["SN-0001"]!;
    const two = { ...L, entries: L.entries.slice(0, 2) };
    const r2 = await verifyLedger(two, lab.ctx("printed-part", lab.revA));
    const skip = await forceAppend(two, k.operator!, {
      ...(two.entries[1]!.record as Record<string, unknown>), recordId: await uuidFor("invalid-skip/3"), seq: 3, prev: r2.head, action: "dispatch-build", at: iso(20),
      actor: { keyId: k.operator!.keyId, organization: ORG.cell, role: "operator" }, unit: { serial: "SN-0001" }, outcome: "started", evidence: [], reason: "Printing straight after release, skipping suitability, planning and authorization (forbidden; synthetic)",
      data: { kind: "build-start", jobId: "J-9999", resource: "H2C-LAB-01", startedAt: iso(20) },
    });
    invalid["invalid-skip"] = skip;
    const r = await verifyLedger(skip, lab.ctx("printed-part", lab.revA));
    demo("P04-a", "A validly signed build start that skips suitability, planning and authorization", "ledger rejected: not allowed from state source-released", failures(r), r.verdict === "rejected" && /not allowed from state source-released/.test(failures(r)));
    const plan = await denied(() => appendRecord({ ...L, entries: L.entries.slice(0, 1) }, lab.ctx("printed-part", lab.revA, at(20)), k.planner!, { action: "plan-build", role: "planner", outcome: "planned", reason: "try", data: { kind: "plan", buildPlanId: "BP-X", settings: {}, inspectionPlan: [], geometryReview: [] } }));
    demo("P04-b", "Planning before source release is recorded (missing approval/evidence step)", "DENIED before signing", plan, plan.startsWith("DENIED") && /not allowed from state requirements-approved/.test(plan));
    const noEv = await denied(() => appendRecord({ ...L, entries: L.entries.slice(0, 2) }, lab.ctx("printed-part", lab.revA, at(30)), k["mfg-eng"]!, { action: "review-suitability", role: "manufacturing-engineer", outcome: "review-required", reason: "try", data: (L.entries[2]!.record as { data: never }).data, evidence: [] }));
    demo("P04-c", "Suitability review without the required capability-study / calibration evidence", "DENIED: requires evidence tagged capability-study", noEv, /requires evidence tagged capability-study/.test(noEv));
    const claimed = await forceAppend({ ...lab.ledgers["SN-0002"]!, entries: lab.ledgers["SN-0002"]!.entries.slice(0, 9) }, k.inspector!, {
      ...(lab.ledgers["SN-0002"]!.entries[9]!.record as Record<string, unknown>), outcome: "accept", reason: "Claims accept although the rules reject (forbidden; synthetic)",
    });
    invalid["invalid-inspection-claim"] = claimed;
    const rc = await verifyLedger(claimed, lab.ctx("printed-part", lab.revA));
    demo("P04-d", "An inspection record that claims 'accept' when the decision rules give 'reject'", "ledger rejected: decision rules give reject", failures(rc), /decision rules give reject/.test(failures(rc)));
    const stale = await denied(async () => {
      const p = await prelude(lab, "REVB-NOREVIEW", lab.revB, ["SN-0040"], { offset: 25 * 60 });
      return p.get();
    });
    const ok = await denied(async () => prelude(lab, "REVB-REVIEWED", lab.revB, ["SN-0040"], { offset: 25 * 60, geometryReview: [{ link: "GL-002", resolution: "Overall length unaffected by the tab change; selector re-checked against rev B STEP (synthetic)" }] }));
    demo("P04-e", "Rev B carries geometry link GL-002 over from rev A (stale): planning is held until the plan records a review", "DENIED without review; ALLOWED with review", `${stale.slice(0, 110)}…; with review: ${ok}`, /GL-002 .* is stale/.test(stale) && ok === "ALLOWED");
  }

  // P05 authorization
  {
    const L = lab.ledgers["SN-0001"]!;
    const upTo = (n: number) => ({ ...L, entries: L.entries.slice(0, n) });
    const queued = upTo(7); // after enter-queue J-0001
    const dispatch = (who: string, m: number, extra: Partial<RecordInput> = {}) => () => appendRecord(queued, lab.ctx("printed-part", lab.revA, at(m)), k[who]!, { action: "dispatch-build", role: "operator", outcome: "started", unit: { serial: "SN-0001" }, reason: "try", data: { kind: "build-start", jobId: "J-0001", resource: "H2C-LAB-01", startedAt: iso(m) }, ...extra });
    const outsider = await denied(dispatch("outsider", 110));
    demo("P05-a", "A trusted key with no workflow grant tries to dispatch", "DENIED: no grant or valid delegation", outsider, /no grant or valid delegation/.test(outsider));
    const revoked = await denied(dispatch("revoked-op", 110));
    demo("P05-b", "A key revoked in the authority configuration tries to dispatch", "DENIED: revoked", revoked, /revoked/.test(revoked));
    const authorized = upTo(6); // after the CIP
    const jobFile = lab.evidence["job-J-0001.txt"]!;
    const expired = await denied(async () => appendRecord(authorized, lab.ctx("printed-part", lab.revA, at(90 + 15 * 24 * 60)), k.planner!, { action: "enter-queue", role: "planner", outcome: "queued", unit: { serial: "SN-0001" }, reason: "try", data: { kind: "queue-entry", jobId: "J-LATE", submittedFile: { name: jobFile.name, sha256: await sha256Hex(jobFile.bytes) }, settings: {} }, evidence: [await E(lab, jobFile.name, "EV-JOB")] }));
    demo("P05-c", "Queueing after the CIP's validity period has ended", "DENIED: not authorized (outside CIP window)", expired, /not authorized: CIP CIP-SN-0001 is valid/.test(expired));
    const staleNow = await denied(dispatch("operator", 8 * 24 * 60));
    demo("P05-d", "Dispatch 8 days after the authority configuration was issued (offline validity 168 h)", "DENIED: freshness can't be established offline", staleNow, /can't be established offline/.test(staleNow));
    const spoof = await denied(async () => {
      const ctx = lab.ctx("printed-part", lab.revA, at(110));
      // The trust store is operator configuration; the organization a record asserts is checked against it.
      const r = await verifyLedger(await forceAppend(queued, k.outsider!, { ...(queued.entries[6]!.record as Record<string, unknown>), recordId: await uuidFor("spoof"), seq: 8, prev: (await verifyLedger(queued, ctx)).head, action: "dispatch-build", at: iso(110), actor: { keyId: k.outsider!.keyId, organization: ORG.design, role: "operator" }, outcome: "started", evidence: [], data: { kind: "build-start", jobId: "J-0001", resource: "H2C-LAB-01", startedAt: iso(110) } }), ctx);
      throw new TransitionDenied(failures(r));
    });
    demo("P05-e", "A signed record that asserts an organization the trust store doesn't bind to the key", "rejected: trust store binds the key to another organization", spoof, /binds the key to/.test(spoof));
    const selfDel = await denied(() => appendRecord(queued, lab.ctx("printed-part", lab.revA, at(105)), k["cell-lead"]!, { action: "delegate", role: "operator", outcome: "issued", reason: "self", data: { kind: "delegation", subject: k["cell-lead"]!.keyId, organization: ORG.cell, role: "operator", processes: ["printed-part"], notBefore: iso(105), notAfter: iso(200) } }));
    demo("P05-f", "A key tries to delegate authority to itself", "DENIED: can't grant authority to its own signer", selfDel, /own signer/.test(selfDel));
    const v2 = await loadProcess(utf8.decode(processBytes(printedPartProcess(2))));
    const ctxV2 = { ...lab.ctx("printed-part", lab.revA), process: v2 };
    const rv2 = await verifyLedger(L, ctxV2);
    demo("P05-g", "Loading a changed process definition (v2) that the authority does not pin", "rejected: authority does not pin process v2", failures(rv2), /does not pin process printed-part v2/.test(failures(rv2)));
    const expiredAuth = await verifyLedger(L, lab.ctx("printed-part", lab.revA, new Date("2027-12-01T00:00:00Z")));
    demo("P05-h", "Verifying after the authority configuration expired", "rejected: authority configuration expired", failures(expiredAuth), /expired/.test(failures(expiredAuth)));
  }

  // P06 integrity and recovery
  let checkpoint!: Awaited<ReturnType<typeof makeCheckpoint>>;
  {
    const L = lab.ledgers["SN-0001"]!;
    const ctx = lab.ctx("printed-part", lab.revA);
    const altered = JSON.parse(JSON.stringify(L)) as LedgerFile;
    (altered.entries[13]!.record as { data: { measurements: { value: number }[] } }).data.measurements[0]!.value = 6.1;
    const ra = await verifyLedger(altered, ctx);
    demo("P06-a", "A measured value edited in a signed record", "rejected: signature over different bytes", failures(ra), /signature is over different bytes/.test(failures(ra)));
    const removed = { ...L, entries: [...L.entries.slice(0, 5), ...L.entries.slice(6)] };
    const rr = await verifyLedger(removed, ctx);
    demo("P06-b", "A record removed from the middle", "rejected", failures(rr), rr.verdict === "rejected");
    checkpoint = await makeCheckpoint(results["SN-0001"]!, LAB_NOW);
    const truncated = { ...L, entries: L.entries.slice(0, -2) };
    invalid["SN-0001-truncated"] = truncated;
    const rt = await verifyLedger(truncated, ctx);
    const cp = checkCheckpoint(rt, checkpoint);
    demo("P06-c", "The newest two records dropped: the chain alone still verifies; an independently retained checkpoint detects it", "chain verifies; checkpoint reports truncation", `${rt.verdict}; checkpoint: ${cp}`, rt.verdict === "verified" && /truncated/.test(cp ?? ""));
    const swapped = new Map(lab.store);
    const meas = await sha256Hex(lab.evidence["measurements-SN-0001.csv"]!.bytes);
    swapped.delete(meas);
    swapped.set(await sha256Hex(utf8.encode("tampered measurement sheet")), { name: "measurements-SN-0001.csv", size: 26 });
    const rh = await verifyLedger(L, { ...ctx, evidence: swapped });
    demo("P06-d", "A measurement evidence file altered after recording", "held: its hash can't be checked; nothing is accepted on the altered file", `${rh.verdict}: ${rh.checks.filter((c) => c.status === "held").map((c) => c.message).join(" | ").slice(0, 120)}…`, rh.verdict === "held");
    const tampered = rezip(lab.revA.tdp, (f) => { f["engineering/model.json"] = utf8.encode(utf8.decode(f["engineering/model.json"]!).replace('"upper": 6.2', '"upper": 6.3')); });
    const rtp = await verifyPackage(tampered, lab.trustStore, defaultPolicy, LAB_NOW);
    let bind = "";
    try { baselineFrom(rtp); } catch (e) { bind = (e as Error).message; }
    demo("P06-e", "An inspection limit widened inside the signed engineering model", "package rejected; no ledger can bind to it", `${rtp.verdict}: ${failures(rtp).slice(0, 80)}; ${bind}`, rtp.verdict === "rejected" && /not trusted/.test(bind));
    const recovered = await verifyLedger(JSON.parse(JSON.stringify(L)), ctx);
    demo("P06-f", "Recovery: re-verifying the retained ledger and evidence from scratch", "verified, same head as the checkpoint", `${recovered.verdict}, head ${recovered.head?.slice(0, 16)}…`, recovered.verdict === "verified" && recovered.head === checkpoint.head);
  }

  // P06 continued: Merkle custody log witnessed by another organization.
  let custody!: LabRun["custody"];
  {
    const L = lab.ledgers["SN-0001"]!;
    const ctx = lab.ctx("printed-part", lab.revA);
    const witnessKey = k.quality!; // Lab Inspection: not the ledger's holder
    const at8 = await verifyLedger({ ...L, entries: L.entries.slice(0, 8) }, ctx);
    const head8 = await signTreeHead(at8, witnessKey, { now: at(115) });
    const full = results["SN-0001"]!;
    const head16 = await signTreeHead(full, witnessKey, { now: at(365) });
    const proof = await consistencyProof(8, leavesOf(full));
    let witness: Witness = { schema: "tdp-witness/0.1", heads: [] };
    witness = await witnessHead(witness, head8, lab.trustStore);
    witness = await witnessHead(witness, head16, lab.trustStore, proof);
    const truncated = await verifyLedger({ ...L, entries: L.entries.slice(0, -2) }, ctx);
    const tc = await checkLedgerAgainstHeads(truncated, witness.heads, lab.trustStore);
    demo("P06-h", "The newest records dropped from SN-0001; heads signed by another organization (the inspection lab) still hold the full history", "truncation detected from signed heads, no hand-kept checkpoint needed", tc.map((c) => `${c.status}: ${c.message}`).join(" | ").slice(0, 260), tc.some((c) => c.status === "truncated") && tc.some((c) => c.status === "consistent"));
    // The holder rewrites the last record and signs a head over the rewritten history.
    const forked = JSON.parse(JSON.stringify(L)) as LedgerFile;
    forked.entries.pop();
    const rewritten = await appendRecord(forked, lab.ctx("printed-part", lab.revA, at(400)), k["config-mgr"]!, { action: "close-evidence", role: "configuration-manager", outcome: "closed", unit: { serial: "SN-0001" }, reason: "rewritten closure", data: { kind: "closure", summary: "rewritten (synthetic fork)" } }, { recordId: await uuidFor("fork-closure") });
    const forkHead = await signTreeHead(await verifyLedger(rewritten.ledger, ctx), k["config-mgr"]!, { now: at(400) });
    let refused = "";
    try { await witnessHead(witness, forkHead, lab.trustStore); } catch (e) { refused = (e as Error).message; }
    const forks = findForks([...witness.heads, forkHead]);
    demo("P06-i", "The holder rewrites a record and signs a head over the rewritten 16-record history", "witness refuses it; the two signed heads are themselves proof of a fork", `${refused.slice(0, 120)}; forks found: ${forks.length}`, /fork/.test(refused) && forks.length === 1);
    const consistent = await verifyConsistency(head8.treeSize, head8.rootHash, head16.treeSize, head16.rootHash, proof);
    const forgedProof = await consistencyProof(8, leavesOf(await verifyLedger(rewritten.ledger, ctx)));
    const forkConsistent = await verifyConsistency(head8.treeSize, head8.rootHash, forkHead.treeSize, forkHead.rootHash, forgedProof);
    const incl = await verifyInclusion(full.records[13]!.sha256, 13, head16.treeSize, head16.rootHash, await inclusionProof(13, leavesOf(full)));
    demo("P06-j", "Without the ledger: a consistency proof shows the 16-record head extends the 8-record head; an inclusion proof shows the inspection record is in it", "consistency verifies; inclusion verifies", `consistency 8→16: ${consistent}; inclusion of record 14: ${incl}; (the forked head is still consistent with 8: ${forkConsistent}, since the fork is after record 8)`, consistent && incl);
    custody = { witness, head8, head16, proof: { schema: "tdp-consistency-proof/0.1", instance: full.instance!.id, fromSize: 8, toSize: 16, proof }, forkHead };
  }

  // P07 exchange boundary
  const packageHashBefore = await sha256Hex(lab.revA.tdp);
  const ledgerHashBefore = await canonicalSha256(lab.ledgers["SN-0002"]);
  const recipe = await labRecipe(lab);
  const initial = fixtureSource(lab);
  const plmKey = lab.world.keys["source-plm"]!;
  const adapter = new LocalFixtureAdapter(JSON.parse(JSON.stringify(initial)), plmKey);
  const baselineA = baselineFrom(lab.revA.result);
  const proposals = await buildProposals(recipe, baselineA, results["SN-0001"]!, adapter.describe(), { now: LAB_NOW });
  const acks = await adapter.reconcile(proposals, LAB_NOW);
  const imported = await importAcknowledgements(proposals, acks, { trustStore: lab.trustStore, authority: lab.authority.config, now: LAB_NOW });
  const objectsAfter = JSON.stringify(adapter.state.objects);
  const replay = await adapter.reconcile(proposals, LAB_NOW);
  const objectsAfterReplay = JSON.stringify(adapter.state.objects);
  const proposals2 = await buildProposals(recipe, baselineA, results["SN-0002"]!, adapter.describe(), { now: LAB_NOW });
  const acks2 = await adapter.reconcile(proposals2, LAB_NOW);
  {
    const count = (a: AckSet) => a.acks.reduce<Record<string, number>>((m, x) => ({ ...m, [x.status]: (m[x.status] ?? 0) + 1 }), {});
    demo("P07-a", "SN-0001 proposals to the fixture PLM: AsBuiltUnit create then update (expected version 1), lossy-but-accepted InspectionResult, held lossy ProcessReview, unsupported ProcessPlan", "accepted ×4, rejected (lossy held) ×1, unsupported ×1", JSON.stringify(count(acks)), count(acks).accepted === 4 && count(acks).unsupported === 1 && count(acks).rejected === 1);
    demo("P07-b", "Replaying the same transactions", "all duplicate; source objects unchanged", `${JSON.stringify(count(replay))}; objects ${objectsAfterReplay === objectsAfter ? "unchanged" : "CHANGED"}`, replay.acks.every((a) => a.status === "duplicate") && objectsAfterReplay === objectsAfter);
    const forged = JSON.parse(JSON.stringify(proposals)) as ProposalSet;
    const tx = forged.transactions.find((t) => t.target.objectType === "AsBuiltUnit")!;
    tx.attributes = { ...tx.attributes, buildOutcome: "completed-with-edit" };
    tx.contentSha256 = await txContentSha256(tx);
    const reuse = await adapter.reconcile(forged, LAB_NOW);
    const reused = reuse.acks.find((a) => a.txId === tx.txId)!;
    demo("P07-c", "Reusing a transaction id with different content", "rejected: transaction id reused with different content", reused.reason, reused.status === "rejected" && /reused/.test(reused.reason));
    const units = acks2.acks.filter((a) => a.objectType === "AsBuiltUnit");
    const manual = adapter.state.objects[`AsBuiltUnit/${PART}:SN-0002`]!;
    demo("P07-d", "SN-0002 AsBuiltUnit already exists at the source with different content; the later update in the same set must not overwrite it", "conflict, then dependent update refused; source object untouched", `${units.map((u) => `${u.status}: ${u.reason}`).join(" | ")}; source object v${manual.version} ${manual.lastTx}`, units.every((u) => u.status === "conflict") && manual.lastTx === "manual");
    const cr = acks2.acks.find((a) => a.objectType === "ChangeRequest");
    const pkgUnchanged = (await sha256Hex(lab.revA.tdp)) === packageHashBefore && (await canonicalSha256(lab.ledgers["SN-0002"])) === ledgerHashBefore;
    demo("P07-e", "An NCR proposed as a ChangeRequest: accepted for review, flagged as needing a newly published baseline; no baseline is altered", "requiresNewBaseline true; package and ledger unchanged", `${cr?.status}, requiresNewBaseline=${cr?.requiresNewBaseline}; package ${pkgUnchanged ? "unchanged" : "CHANGED"}; ${imported.problems.length ? imported.problems.join("; ") : "acks match proposals"}`, cr?.requiresNewBaseline === true && pkgUnchanged && imported.problems.length === 0);
    const moved = new LocalFixtureAdapter({ ...JSON.parse(JSON.stringify(initial)), sourceItems: { ...initial.sourceItems, [PART]: { ...initial.sourceItems[PART]!, revision: "B" } } });
    const pub = (await moved.checkPublication(lab.revA.model)).find((c) => c.source.startsWith(PART))!;
    demo("P07-f", "Publication version check after the source moves to rev B", "rev A reported superseded", pub.message, pub.status === "superseded");
    const tamperedAcks = JSON.parse(JSON.stringify(acks)) as AckSet;
    tamperedAcks.acks.find((a) => a.status === "unsupported")!.status = "accepted";
    const t1 = await importAcknowledgements(proposals, tamperedAcks, { trustStore: lab.trustStore, authority: lab.authority.config, now: LAB_NOW });
    const wrongKey = await new LocalFixtureAdapter(JSON.parse(JSON.stringify(initial)), k.operator!).reconcile(proposals, LAB_NOW);
    const t2 = await importAcknowledgements(proposals, wrongKey, { trustStore: lab.trustStore, authority: lab.authority.config, now: LAB_NOW });
    demo("P07-g", "Acknowledgements are signed by the source system's configured key; an edited ack, or one signed by another trusted key, is refused", "signed ack accepted; both forgeries refused and nothing is marked synchronized", `signed by ${imported.signedBy}; edited: ${t1.problems.join("; ")}; other key: ${t2.problems.join("; ")}; versions kept: ${Object.keys(t1.versions).length + Object.keys(t2.versions).length}`, !!imported.signedBy && /does not verify/.test(t1.problems.join()) && /not configured to acknowledge/.test(t2.problems.join()) && Object.keys(t1.versions).length === 0);
  }

  // Increment 2: supersession, CIP limits, multi-unit lots, signed acknowledgements and bundles.
  {
    const L = lab.ledgers["SN-0001"]!;
    const successors = successorsOf(baselineFrom(lab.revA.result), [lab.revB.result, lab.revA.result]);
    const withSucc = (m: number) => ({ ...lab.ctx("printed-part", lab.revA, at(m)), successors });
    const authorized = { ...L, entries: L.entries.slice(0, 6) };
    const job = lab.evidence["job-J-0001.txt"]!;
    const queue = await denied(async () => appendRecord(authorized, withSucc(100), k.planner!, { action: "enter-queue", role: "planner", outcome: "queued", unit: { serial: "SN-0001" }, reason: "try", data: { kind: "queue-entry", jobId: "J-NEW", submittedFile: { name: job.name, sha256: await sha256Hex(job.bytes) }, settings: {} }, evidence: [await E(lab, job.name, "EV-JOB")] }));
    const held3 = lab.ledgers["SN-0003"]!;
    const reinspect = await denied(async () => appendRecord(held3, withSucc(400), k.inspector!, { action: "inspect", role: "inspector", outcome: "accept", unit: { serial: "SN-0003" }, reason: "Re-measured with the micrometer at 20 °C (synthetic)", data: { kind: "inspection", decisionRules: "core/decision-rules/0.1", measurements: measurementsFor([6.15, 40.01, 20.02], undefined, 400) }, evidence: [await E(lab, "measurements-SN-0003.csv", "EV-MEAS"), await E(lab, "micrometer-MIC-07-cal.txt", "EV-MIC"), await E(lab, "caliper-CAL-12-cal.txt", "EV-CAL")] }));
    const st = workflowStatus(await verifyLedger(L, withSucc(400)), withSucc(400));
    demo("P01-f", "Once rev B (which supersedes rev A) is known, new work under rev A is refused, but a unit in progress may still be re-inspected", "queue DENIED as superseded; re-inspection ALLOWED; baseline status warns", `${queue.slice(0, 120)}…; re-inspect: ${reinspect}; status: ${st.baseline.text.slice(0, 60)}…`, /superseded by BL-SYN-PH-2000-B/.test(queue) && reinspect === "ALLOWED" && st.baseline.level === "warn");

    // CIP limit: dispatch-build at most twice. SN-0001's CIP has been used twice (J-0001 failed, J-0002).
    let X: LedgerFile = { ...L, entries: L.entries.slice(0, 12) }; // through dispatch J-0002
    const ctxM = (m: number) => lab.ctx("printed-part", lab.revA, at(m));
    X = (await appendRecord(X, ctxM(205), k.operator2!, { action: "complete-build", role: "operator", outcome: "failed", unit: { serial: "SN-0001" }, reason: "Second failure (synthetic, for the limit demonstration)", data: { kind: "build-complete", jobId: "J-0002", submittedFileSha256: await sha256Hex(lab.evidence["job-J-0002.txt"]!.bytes), startedAt: iso(160), completedAt: iso(200), errors: ["warping (synthetic)"], settings: {} }, evidence: [await E(lab, "build-log-J-0002.txt", "EV-LOG")] })).ledger;
    X = (await appendRecord(X, ctxM(210), k.operator!, { action: "enter-queue", role: "operator", outcome: "queued", unit: { serial: "SN-0001" }, reason: "Third attempt", data: { kind: "queue-entry", jobId: "J-0003", submittedFile: { name: job.name, sha256: await sha256Hex(job.bytes) }, settings: {} }, evidence: [await E(lab, job.name, "EV-JOB")] })).ledger;
    const third = await denied(() => appendRecord(X, ctxM(215), k.operator!, { action: "dispatch-build", role: "operator", outcome: "started", unit: { serial: "SN-0001" }, reason: "try", data: { kind: "build-start", jobId: "J-0003", resource: "H2C-LAB-01", startedAt: iso(215) } }));
    demo("P05-i", "A CIP that allows at most two dispatches: a third attempt needs a new authorization", "DENIED: at most 2 dispatch-build, 2 already used", third, /at most 2 dispatch-build record\(s\), and 2 already used/.test(third));

    const lot = await verifyLedger(lab.ledgers["LOT-0004"]!, lab.ctx("printed-part", lab.revA));
    const states = lot.units.map((u) => `${unitLabel(u.unit)}=${u.state}`).join(", ");
    const s4 = workflowStatus(lot, lab.ctx("printed-part", lab.revA), { serial: "SN-0004" });
    const s5 = workflowStatus(lot, lab.ctx("printed-part", lab.revA), { serial: "SN-0005" });
    demo("P02-d", "A lot of two serials in one ledger: shared approvals and CIP, separate unit tracks (one accepted and incorporated, one scrapped)", "SN-0004 closed, SN-0005 scrapped; statuses per unit", `${lot.verdict}; ${states}; ${s4.disposition.text}; ${s5.disposition.text}`, lot.verdict === "verified" && /SN-0004=closed/.test(states) && /SN-0005=scrapped/.test(states));
    // After SN-0005's NCR, before its disposition: try to use-as-is it by citing SN-0004's accepted inspection.
    const beforeDisp = { ...lab.ledgers["LOT-0004"]!, entries: lab.ledgers["LOT-0004"]!.entries.slice(0, 15) };
    const crossed = await denied(async () => appendRecord(beforeDisp, lab.ctx("printed-part", lab.revA, at(270)), k.mrb!, { action: "disposition", role: "disposition-authority", outcome: "use-as-is", unit: { serial: "SN-0005" }, reason: "try", data: { kind: "disposition", inspectionRecord: await uuidFor("LOT-0004/13"), ncrId: "NCR-0004", rationale: "citing SN-0004's inspection" } }));
    demo("P03-f", "Dispositioning SN-0005 by citing SN-0004's accepted inspection", "DENIED: a unit is dispositioned against its own latest inspection", crossed, /must disposition the latest inspection/.test(crossed));
  }

  // P08 measured performance (software only)
  const performance: LabRun["performance"] = [];
  {
    const time = async (n: number, fn: () => Promise<unknown>) => { const t = performance_now(); for (let i = 0; i < n; i++) await fn(); return (performance_now() - t) / n; };
    const ctx = lab.ctx("printed-part", lab.revA);
    const pkgMs = await time(5, () => verifyPackage(lab.revA.tdp, lab.trustStore, defaultPolicy, LAB_NOW));
    const ledMs = await time(5, () => verifyLedger(lab.ledgers["SN-0001"]!, ctx));
    const n = lab.ledgers["SN-0001"]!.entries.length;
    const bytes = utf8.encode(JSON.stringify(lab.ledgers["SN-0001"]));
    performance.push(
      { metric: "package verification (rev A, 6 files)", value: round(pkgMs), unit: "ms", note: "mean of 5, this machine" },
      { metric: `ledger verification (SN-0001, ${n} records)`, value: round(ledMs), unit: "ms", note: "mean of 5, includes every gate re-evaluation" },
      { metric: "ledger verification per record", value: round(ledMs / n), unit: "ms", note: "full chain re-verified from genesis" },
      { metric: "ledger size", value: bytes.length, unit: "bytes", note: `${n} signed records` },
    );
    const big = await buildLargeLedger(lab, 45, 3);
    const bigStart = performance_now();
    const bigR = await verifyLedger(big, ctx);
    const bigMs = performance_now() - bigStart;
    performance.push(
      { metric: `large ledger verification (45 units, ${big.entries.length} records)`, value: round(bigMs), unit: "ms", note: "one lot, 3 failed builds per unit before success; single run" },
      { metric: "large ledger verification per record", value: round(bigMs / big.entries.length), unit: "ms", note: "scales linearly in this range" },
    );
    demo("P08-b", `A ${big.entries.length}-record ledger (45 units in one lot) verifies completely, every unit tracked separately`, "verified; 45 units closed", `${bigR.verdict}; ${bigR.units.filter((u) => u.state === "closed").length} units closed; ${round(bigMs)} ms`, bigR.verdict === "verified" && bigR.units.filter((u) => u.state === "closed").length === 45);
    demo("P08-a", "Software verification timings measured on this machine (no physical build time, cycle time or yield is claimed)", "measurements recorded", performance.map((p) => `${p.metric}: ${p.value} ${p.unit}`).join("; "), performance.every((p) => p.value > 0));
  }

  const bundle = buildEvidenceBundle({
    verify: lab.revA.result,
    trustStoreSha256: await canonicalSha256(lab.trustStore),
    ledger: results["SN-0001"]!,
    ctx: lab.ctx("printed-part", lab.revA),
    ledgerSha256: await canonicalSha256(lab.ledgers["SN-0001"]),
    reconciliation: { proposals, rows: imported.rows },
    demonstrations: demos,
    performance,
    now: LAB_NOW,
  });
  const signedBundle = await signEvidenceBundle(bundle, lab.world.keys["config-mgr"]!, LAB_NOW);
  const good = await verifySignedEvidence(JSON.parse(JSON.stringify(signedBundle)), lab.trustStore);
  const altered = JSON.parse(JSON.stringify(signedBundle));
  altered.bundle.status.inspection = "Inspection accepted (edited)";
  const bad = await verifySignedEvidence(altered, lab.trustStore);
  demos.push({ id: "P06-g", scenario: "Signed evidence bundle: verifies as exported, fails after any edit", expected: "valid; altered copy refused", actual: `signed by ${good.signer}; altered: ${bad.problem}`, pass: !!good.signer && /does not verify/.test(bad.problem ?? "") });
  bundle.demonstrations = demos;
  const finalSigned = await signEvidenceBundle(bundle, lab.world.keys["config-mgr"]!, LAB_NOW);
  return { lab, demonstrations: demos, results, signedBundle: finalSigned, custody, exchange: { recipe, initial, after: adapter.state, proposals, acks, replay, proposals2, acks2 }, checkpoint, invalid, performance, bundle };
}

const performance_now = () => globalThis.performance.now();
const round = (x: number) => Math.round(x * 100) / 100;

/** Reads the committed 0.1 sample, for the compatibility demonstration. */
export function legacySample() {
  return { tdp: new Uint8Array(readFileSync("samples/sample.tdp")), trustJson: readFileSync("samples/trust-store.json", "utf8") };
}

/**
 * A large but fully valid ledger for performance measurement: `units` serials in one lot, each with
 * `failedCycles` failed builds before a good one, then inspection, disposition and closure. Records
 * are signed directly (the gate is applied once, by the verification being measured).
 */
export async function buildLargeLedger(lab: Lab, units: number, failedCycles: number): Promise<LedgerFile> {
  const serials = Array.from({ length: units }, (_, i) => `SN-${String(6 + i).padStart(4, "0")}`);
  const p = await prelude(lab, `PERF-${units}-${failedCycles}`, lab.revA, serials);
  let L = p.get();
  const ctx = lab.ctx("printed-part", lab.revA);
  const base = L.entries[0]!.record as Record<string, unknown>;
  let head = (await verifyLedger(L, ctx)).head!;
  let t = Date.parse(iso(100));
  const ev = async (name: string, id: string) => ref(lab.evidence[name]!, id);
  const jobFile = lab.evidence["job-J-0101.txt"]!;
  const jobSha = await sha256Hex(jobFile.bytes);
  const who = (k: string, org: string, role: string) => ({ keyId: lab.world.keys[k]!.keyId, organization: org, role });
  const add = async (key: string, org: string, role: string, serial: string, action: string, outcome: string, data: unknown, evidence: unknown[] = []) => {
    t += 3_000;
    const record = { ...base, recordId: await uuidFor(`perf/${L.entries.length + 1}/${units}/${failedCycles}`), seq: L.entries.length + 1, unit: { serial }, actor: who(key, org, role), action, at: new Date(t).toISOString(), prev: head, evidence, outcome, reason: "performance fixture (synthetic)", data };
    L = await forceAppend(L, lab.world.keys[key]!, record);
    head = await canonicalSha256(record);
  };
  const meas = measurementsFor([6.03, 40.02, 19.97], undefined, 0);
  let job = 0;
  for (const serial of serials) {
    for (let c = 0; c <= failedCycles; c++) {
      const jobId = `PJ-${++job}`;
      const ok = c === failedCycles;
      await add("planner", ORG.cell, "planner", serial, "enter-queue", "queued", { kind: "queue-entry", jobId, submittedFile: { name: jobFile.name, sha256: jobSha }, settings: {} }, [await ev(jobFile.name, "EV-JOB")]);
      await add("operator", ORG.cell, "operator", serial, "dispatch-build", "started", { kind: "build-start", jobId, resource: "H2C-LAB-01", startedAt: new Date(t).toISOString() });
      await add("operator", ORG.cell, "operator", serial, "complete-build", ok ? "completed" : "failed", { kind: "build-complete", jobId, submittedFileSha256: jobSha, startedAt: new Date(t).toISOString(), completedAt: new Date(t + 1000).toISOString(), errors: ok ? [] : ["synthetic failure"], settings: {} }, [await ev("build-log-J-0101.txt", "EV-LOG")]);
    }
    await add("inspector", ORG.lab, "inspector", serial, "inspect", "accept", { kind: "inspection", decisionRules: "core/decision-rules/0.1", measurements: meas.map((m) => ({ ...m, measuredAt: new Date(t).toISOString() })) }, [await ev("measurements-SN-0001.csv", "EV-MEAS"), await ev("micrometer-MIC-07-cal.txt", "EV-MIC"), await ev("caliper-CAL-12-cal.txt", "EV-CAL")]);
    const inspId = (L.entries.at(-1)!.record as { recordId: string }).recordId;
    await add("mrb", ORG.design, "disposition-authority", serial, "disposition", "accept", { kind: "disposition", inspectionRecord: inspId, rationale: "performance fixture" });
    await add("config-mgr", ORG.design, "configuration-manager", serial, "close-evidence", "closed", { kind: "closure", summary: "performance fixture" });
  }
  return L;
}
