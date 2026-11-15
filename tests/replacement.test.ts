import { beforeAll, describe, expect, it } from "vitest";
import {
  TransitionDenied,
  buildEvidenceBundle,
  canonicalSha256,
  evaluateInspection,
  verifyLedger,
  workflowStatus,
  type Characteristic,
  type Measurement,
} from "../src/core";
import { sha256Hex } from "../src/core/bytes";
import { LAB_NOW, iso, ref, uuidFor } from "../tools/lab-fixtures";
import { buildLedgers, measurementsFor, prelude, setupLab, type Lab } from "../tools/lab-scenario";

let lab: Lab;
beforeAll(async () => {
  lab = await setupLab();
  await buildLedgers(lab);
}, 60_000);

const ctx = () => lab.ctx("printed-part", lab.revA);
const sn = (serial: string) => ({ serial });
type Replaces = { unit: { serial: string }; ncrId: string };

/** A ledger with `serials` authorized, and helpers to move units through build, inspection and NCR. */
async function world(name: string, serials: string[]) {
  const p = await prelude(lab, name, lab.revA, serials);
  const job = lab.evidence["job-J-0101.txt"]!;
  const jobSha = await sha256Hex(job.bytes);
  const jobEv = await ref(job, "EV-JOB");
  const logEv = await ref(lab.evidence["build-log-J-0101.txt"]!, "EV-LOG");
  const measEv = [await ref(lab.evidence["measurements-SN-0002.csv"]!, "EV-MEAS"), await ref(lab.evidence["micrometer-MIC-07-cal.txt"]!, "EV-MIC"), await ref(lab.evidence["caliper-CAL-12-cal.txt"]!, "EV-CAL")];
  let m = 100;
  let jobs = 0;
  const queue = (serial: string, replaces?: Replaces) =>
    p.s("planner", ++m, { action: "enter-queue", role: "planner", outcome: "queued", unit: sn(serial), reason: "Queued", data: { kind: "queue-entry", jobId: `J-${name}-${++jobs}`, submittedFile: { name: job.name, sha256: jobSha }, settings: {}, ...(replaces ? { replaces } : {}) }, evidence: [jobEv] });
  const dispatch = (serial: string, replaces?: Replaces) =>
    p.s("operator", ++m, { action: "dispatch-build", role: "operator", outcome: "started", unit: sn(serial), reason: "Dispatched", data: { kind: "build-start", jobId: `J-${name}-${jobs}`, resource: "H2C-LAB-01", startedAt: iso(m), ...(replaces ? { replaces } : {}) } });
  const complete = (serial: string) =>
    p.s("operator", ++m, { action: "complete-build", role: "operator", outcome: "completed", unit: sn(serial), reason: "Completed", data: { kind: "build-complete", jobId: `J-${name}-${jobs}`, submittedFileSha256: jobSha, startedAt: iso(m - 1), completedAt: iso(m), errors: [], settings: {} }, evidence: [logEv] });
  const reject = async (serial: string, ncrId: string) => {
    await p.s("inspector", ++m, { action: "inspect", role: "inspector", outcome: "reject", unit: sn(serial), reason: "Measured", data: { kind: "inspection", decisionRules: "core/decision-rules/0.1", measurements: measurementsFor([6.25, 40.05, 19.95], undefined, m) }, evidence: measEv });
    const inspection = (p.get().entries.at(-1)!.record as { recordId: string }).recordId;
    await p.s("inspector", ++m, { action: "raise-nonconformance", role: "inspector", outcome: "raised", unit: sn(serial), reason: "Over maximum", data: { kind: "nonconformance", ncrId, inspectionRecord: inspection, characteristics: ["CH-001"], description: "CH-001 over maximum (synthetic)" } });
    return inspection;
  };
  const build = async (serial: string, replaces?: Replaces) => { await queue(serial, replaces); await dispatch(serial); await complete(serial); };
  const denied = async (fn: () => Promise<unknown>) => { try { await fn(); return "ALLOWED"; } catch (e) { if (e instanceof TransitionDenied) return e.message; throw e; } };
  return { p, queue, dispatch, complete, reject, build, denied, at: () => ++m };
}

describe("replacement articles", () => {
  it("can't replace itself, even when reworked back into the build queue", async () => {
    const w = await world("REWORK", ["SN-0040"]);
    await w.build("SN-0040");
    const inspection = await w.reject("SN-0040", "NCR-0040");
    await w.p.s("mrb", w.at(), { action: "disposition", role: "disposition-authority", outcome: "rework", unit: sn("SN-0040"), reason: "Rework", data: { kind: "disposition", inspectionRecord: inspection, ncrId: "NCR-0040", rationale: "Reprint" } });
    expect(await w.denied(() => w.queue("SN-0040", { unit: sn("SN-0040"), ncrId: "NCR-0040" }))).toMatch(/can't replace itself/);
    expect(await w.denied(() => w.queue("SN-0040"))).toBe("ALLOWED");
  });

  it("allows a second replacement once the first replacement has its own NCR, and the chain verifies", async () => {
    const w = await world("CHAIN", ["SN-0041", "SN-0042", "SN-0043"]);
    await w.build("SN-0041");
    await w.reject("SN-0041", "NCR-0041");
    await w.build("SN-0042", { unit: sn("SN-0041"), ncrId: "NCR-0041" });
    expect(await w.denied(() => w.queue("SN-0043", { unit: sn("SN-0041"), ncrId: "NCR-0041" }))).toMatch(/already answered by replacement SN-0042/);
    await w.reject("SN-0042", "NCR-0042");
    expect(await w.denied(() => w.queue("SN-0043", { unit: sn("SN-0041"), ncrId: "NCR-0041" }))).toBe("ALLOWED");
    const r = await verifyLedger(w.p.get(), ctx());
    expect(r.verdict).toBe("verified");
    const bundle = buildEvidenceBundle({ verify: lab.revA.result, trustStoreSha256: "0".repeat(64), ledger: r, ctx: ctx(), ledgerSha256: await canonicalSha256(w.p.get()), now: LAB_NOW });
    const u = (s: string) => bundle.units.find((x) => x.unit.serial === s)!;
    expect(u("SN-0041").replacedBy.map((x) => x.unit.serial)).toEqual(["SN-0042", "SN-0043"]);
    expect(u("SN-0042").replaces).toEqual({ unit: sn("SN-0041"), ncrId: "NCR-0041" });
    expect(u("SN-0042").nonconformances.map((n) => n.ncrId)).toEqual(["NCR-0042"]);
  });

  it("keeps one claim per unit: a build record can restate it but not change it", async () => {
    const w = await world("CLAIM", ["SN-0044", "SN-0045", "SN-0046"]);
    await w.build("SN-0044");
    await w.reject("SN-0044", "NCR-0044");
    await w.build("SN-0045");
    await w.reject("SN-0045", "NCR-0045");
    await w.queue("SN-0046", { unit: sn("SN-0044"), ncrId: "NCR-0044" });
    expect(await w.denied(() => w.dispatch("SN-0046", { unit: sn("SN-0045"), ncrId: "NCR-0045" }))).toMatch(/already declared it replaces SN-0044 under NCR NCR-0044/);
    expect(await w.denied(() => w.dispatch("SN-0046", { unit: sn("SN-0044"), ncrId: "NCR-0044" }))).toBe("ALLOWED");
  });

  it("rejects a ledger file that repeats a member name, without throwing", async () => {
    const text = JSON.stringify(lab.ledgers["REPL-SN-0020"]);
    const dup = text.replace('"outcome":"indeterminate"', '"outcome":"indeterminate","outcome":"accept"');
    expect(dup).not.toBe(text);
    const r = await verifyLedger(dup, ctx());
    expect(r.verdict).toBe("rejected");
    expect(r.checks.at(-1)!.message).toMatch(/duplicate member name "outcome"/);
    expect((await verifyLedger(text, ctx())).verdict).toBe("verified");
  });

  it("leaves ledgers without replacement links exactly as they were", async () => {
    for (const name of ["SN-0001", "SN-0002", "SN-0003", "LOT-0004"]) expect((await verifyLedger(lab.ledgers[name]!, ctx())).verdict).toBe("verified");
  });
});

describe("evidence bundle with several units", () => {
  it("reports each unit's own status instead of the instance-level 'not inspected'", async () => {
    const r = await verifyLedger(lab.ledgers["LOT-0004"]!, ctx());
    const b = buildEvidenceBundle({ verify: lab.revA.result, trustStoreSha256: "0".repeat(64), ledger: r, ctx: ctx(), ledgerSha256: "0".repeat(64), now: LAB_NOW });
    expect(b.units.map((u) => [u.unit.serial, u.state, u.latestInspection?.outcome, u.disposition?.outcome])).toEqual([
      ["SN-0004", "closed", "accept", "accept"],
      ["SN-0005", "scrapped", "reject", "scrap"],
    ]);
    expect(b.units[1]!.status.disposition).toBe(workflowStatus(r, ctx(), { serial: "SN-0005" }).disposition.text);
    expect(b.status.inspection).toMatch(/Inspection accepted \(SN-0004\).*Inspection rejected one or more characteristics \(SN-0005\)/);
    expect(b.status.disposition).toMatch(/Dispositioned accept \(SN-0004\).*Dispositioned scrap \(SN-0005\)/);
    expect(b.traceabilityBasis).toEqual({ seq: 14, unit: { serial: "SN-0005" } });
  });
});

describe("instrument resolution is not calibration", () => {
  const ch: Characteristic = { id: "C", requirement: "R", item: { itemId: "I", revision: "A" }, name: "length", unit: "mm", nominal: 40, lower: 39.7, upper: 40.3, decisionRule: "guard-banded" };
  const m = (instrument: Partial<NonNullable<Measurement["instrument"]>>, expanded: number, unit: "mm" | "in" = "mm"): Measurement => ({
    characteristic: "C", value: 40.01, unit: "mm", method: "caliper",
    instrument: { id: "CAL", description: "dial caliper", ...instrument },
    uncertainty: { expanded, k: 2, unit, basis: "b" }, measuredAt: "2026-11-10T00:00:00Z",
  });
  const calibrated = { calibrationEvidence: "EV", calibrationValidUntil: "2027-01-01T00:00:00Z" };
  const evalOne = (x: Measurement) => evaluateInspection([ch], [x], new Set(["EV"])).results[0]!;

  it("holds a measurement whose instrument has a stated resolution but no accuracy evidence", () => {
    const r = evalOne(m({ resolution: { value: 0.001, unit: "in" } }, 0.03));
    expect(r.result).toBe("indeterminate");
    expect(r.reasons.join("; ")).toMatch(/0\.001 in resolution is a readout increment, not evidence of accuracy/);
  });

  it("refuses an uncertainty smaller than the resolution alone contributes (k·r/√12)", () => {
    // 0.001 in = 0.0254 mm; k = 2: floor = 2 × 0.0254 / √12 ≈ 0.014665 mm.
    expect(evalOne(m({ ...calibrated, resolution: { value: 0.001, unit: "in" } }, 0.0146)).reasons.join("; ")).toMatch(/smaller than the resolution contribution alone .* 0\.014664/);
    expect(evalOne(m({ ...calibrated, resolution: { value: 0.001, unit: "in" } }, 0.0146)).result).toBe("indeterminate");
    expect(evalOne(m({ ...calibrated, resolution: { value: 0.001, unit: "in" } }, 0.015)).result).toBe("accept");
    expect(evalOne(m({ ...calibrated, resolution: { value: 0.001, unit: "in" } }, 0.0006, "in")).result).toBe("accept");
    expect(evalOne(m({ ...calibrated, resolution: { value: 0.001, unit: "in" } }, 0.0005, "in")).result).toBe("indeterminate");
  });

  it("holds on a resolution in an incompatible unit, and changes nothing when no resolution is stated", () => {
    expect(evalOne(m({ ...calibrated, resolution: { value: 0.1, unit: "deg" } }, 0.03)).reasons.join("; ")).toMatch(/resolution is in deg, incompatible with mm/);
    expect(evalOne(m(calibrated, 0.001)).result).toBe("accept");
  });

  it("in the lab's replacement ledger: indeterminate before the gauge check, accepted after it", async () => {
    const r = await verifyLedger(lab.ledgers["REPL-SN-0020"]!, ctx());
    expect(r.verdict).toBe("verified");
    const inspections = r.records.filter((v) => v.record.data.kind === "inspection" && v.record.unit?.serial === "SN-0021");
    expect(inspections.map((v) => v.record.outcome)).toEqual(["indeterminate", "accept"]);
    expect(r.units.map((u) => [u.unit.serial, u.state])).toEqual([["SN-0020", "nonconforming"], ["SN-0021", "dispositioned"]]);
    expect(await uuidFor("REPL-SN-0020/16")).toBe(inspections[1]!.record.recordId);
  });
});
