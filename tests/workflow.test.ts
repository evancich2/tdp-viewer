import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  AuditLog,
  PackageSession,
  TransitionDenied,
  appendRecord,
  canonicalJson,
  checkCheckpoint,
  defaultPolicy,
  evaluateInspection,
  evaluateSuitability,
  importAcknowledgements,
  buildProposals,
  LocalFixtureAdapter,
  loadAuthority,
  loadProcess,
  loadTrustStoreFile,
  newLedger,
  validateProcess,
  verifyLedger,
  verifyPackage,
  type Characteristic,
  type LedgerFile,
  type Measurement,
} from "../src/core";
import { utf8 } from "../src/core/bytes";
import { ORG, PART, at, buildLabPackage, buildWorld, iso, printedPartProcess, rezip, uuidFor } from "../tools/lab-fixtures";
import { buildLedgers, fixtureSource, labRecipe, legacySample, runLab, setupLab, type Lab, type LabRun } from "../tools/lab-scenario";
import { addRecord, formatLedger, loadContext } from "../tools/workflow-commands";

let run: LabRun;
let lab: Lab;

beforeAll(async () => {
  run = await runLab({ legacySample: legacySample() });
  lab = run.lab;
}, 60_000);

describe("laboratory demonstrations P01–P08", () => {
  it("all pass, with the expected outcome recorded for each", () => {
    expect(run.demonstrations.length).toBeGreaterThanOrEqual(39);
    for (const d of run.demonstrations) expect(d.pass, `${d.id}: ${d.scenario}\n expected ${d.expected}\n actual   ${d.actual}`).toBe(true);
    for (const p of ["P01", "P02", "P03", "P04", "P05", "P06", "P07", "P08"]) expect(run.demonstrations.some((d) => d.id.startsWith(p))).toBe(true);
  });

  it("verifies every generated ledger, and the second process runs on the same engine", () => {
    for (const name of ["SN-0001", "SN-0002", "SN-0003", "FAI-SN-0010"]) expect(run.results[name]!.verdict, name).toBe("verified");
    expect(run.results["FAI-SN-0010"]!.state).toBe("closed");
    expect(run.results["FAI-SN-0010"]!.records.filter((r) => r.record.data.kind === "inspection").map((r) => r.key.name)).toHaveLength(2);
  });

  it("matches the committed lab samples byte for byte (reproducible)", async () => {
    expect(new Uint8Array(readFileSync("samples/lab/SYN-PH-2000_A.tdp"))).toEqual(lab.revA.tdp);
    expect(JSON.parse(readFileSync("samples/lab/ledgers/SN-0001.ledger.json", "utf8"))).toEqual(lab.ledgers["SN-0001"]);
  });
});

describe("compatibility and versioning", () => {
  it("verifies the committed tdp-manifest/0.1 sample exactly as before", async () => {
    const { tdp, trustJson } = legacySample();
    const { store } = await loadTrustStoreFile(trustJson);
    const r = await verifyPackage(tdp, store, defaultPolicy);
    expect(r.verdict).toBe("trusted");
    expect(r.manifest!.schema).toBe("tdp-manifest/0.1");
    expect(r.engineering).toBeUndefined();
    const s = await PackageSession.open("legacy.tdp", tdp, store, defaultPolicy, new AuditLog());
    expect(s.engineering).toBeUndefined();
  });

  const editManifest = (edit: (m: Record<string, unknown>) => void) =>
    rezip(lab.revA.tdp, (f) => {
      const m = JSON.parse(utf8.decode(f["tdp-manifest.json"]!));
      edit(m);
      f["tdp-manifest.json"] = utf8.encode(JSON.stringify(m, null, 2));
    });

  it("rejects unknown manifest versions and never reinterprets one version as another", async () => {
    for (const [label, edit] of [
      ["unknown 0.3", (m: Record<string, unknown>) => { m.schema = "tdp-manifest/0.3"; }],
      ["0.1 carrying an engineering pointer", (m: Record<string, unknown>) => { m.schema = "tdp-manifest/0.1"; }],
      ["0.2 without its engineering pointer", (m: Record<string, unknown>) => { delete m.engineering; }],
    ] as const) {
      const r = await verifyPackage(editManifest(edit), lab.trustStore, defaultPolicy, at(60));
      expect(r.verdict, label).toBe("rejected");
      expect(r.checks.find((c) => c.id === "manifest")?.status, label).toBe("fail");
    }
  });

  it("rejects an engineering model that claims a STEP solid index is revision-stable", async () => {
    const w = lab.world;
    const p = await buildLabPackage("A", w.keys.author!, w.keys.approver!);
    const model = { ...p.model, geometryLinks: p.model.geometryLinks.map((g) => ({ ...g, stability: "revision-stable" as const })) };
    // Re-sign a package whose model makes that claim.
    const { buildPackage } = await import("../src/core/pack");
    const files = (await import("fflate")).unzipSync(p.tdp);
    const manifest = JSON.parse(utf8.decode(files["tdp-manifest.json"]!));
    const inputs = manifest.files.map((f: { path: string; mediaType: string; role: "spec"; partNumber?: string; revision?: string }) => ({
      path: f.path, mediaType: f.mediaType, role: f.role, partNumber: f.partNumber, revision: f.revision,
      bytes: f.path === "engineering/model.json" ? utf8.encode(JSON.stringify(model)) : files[f.path]!,
    }));
    const tdp = await buildPackage(manifest.package, inputs, manifest.bom, [{ ...w.keys.author!, role: "author" }, { ...w.keys.approver!, role: "approver" }], at(-20), { engineering: "engineering/model.json" });
    const r = await verifyPackage(tdp, lab.trustStore, defaultPolicy, at(60));
    expect(r.verdict).toBe("rejected");
    expect(r.checks.find((c) => c.id === "engineering")!.message).toMatch(/position in one file, not a feature/);
  });

  it("keeps package-signing roles separate from workflow roles", async () => {
    const { SignerRole } = await import("../src/core/schema");
    expect(SignerRole.options).toEqual(["author", "checker", "approver", "release"]);
    // The approver signed the baseline, but holds no workflow grant: it can't approve requirements.
    const L = newLedger(lab.ctx("printed-part", lab.revA, at(0)), { itemId: PART, revision: "A" });
    await expect(appendRecord(L, lab.ctx("printed-part", lab.revA, at(0)), lab.world.keys.approver!, {
      action: "approve-requirements", role: "requirement-owner", outcome: "approved", reason: "x",
      data: { kind: "requirements-approval", requirements: [{ id: "REQ-001", version: 1 }, { id: "REQ-002", version: 1 }, { id: "REQ-003", version: 1 }] },
    })).rejects.toThrow(/no grant or valid delegation/);
  });
});

describe("authority configuration", () => {
  it("follows the trust-store rules: pinned roots, no downgrade, no rollback, no edits", async () => {
    const w = lab.world;
    await expect(loadAuthority(JSON.stringify(w.signedAuthority))).rejects.toThrow(/pin the organization's root/);
    await expect(loadAuthority(utf8.decode(w.authorityBytes), { anchors: w.anchors })).rejects.toThrow(/only signed configurations/);
    await expect(loadAuthority(JSON.stringify(w.signedAuthority), { anchors: w.anchors, seenSerial: 2 })).rejects.toThrow(/rollback/);
    const forged = JSON.parse(JSON.stringify(w.signedAuthority));
    const payload = JSON.parse(utf8.decode(Uint8Array.from(atob(forged.payload), (c) => c.charCodeAt(0))));
    payload.grants[0].roles.push("disposition-authority");
    forged.payload = btoa(String.fromCharCode(...utf8.encode(JSON.stringify(payload))));
    await expect(loadAuthority(JSON.stringify(forged), { anchors: w.anchors })).rejects.toThrow(/no valid signature/);
  });

  it("denies records from a key revoked in the trust store, even ones it signed earlier", async () => {
    const store = { ...lab.trustStore, keys: lab.trustStore.keys.map((k) => (k.keyId === lab.world.keys.inspector!.keyId ? { ...k, revoked: true } : k)) };
    const r = await verifyLedger(lab.ledgers["SN-0001"]!, { ...lab.ctx("printed-part", lab.revA), trustStore: store });
    expect(r.verdict).toBe("rejected");
    expect(r.checks.at(-1)!.message).toMatch(/record 14 .*revoked in the trust store/);
  });

  it("requires inspection from a different organization than the build", async () => {
    const world = await buildWorld({ authorityPatch: (a) => ({ ...a, grants: a.grants.map((g) => (g.roles.includes("planner") ? { ...g, roles: [...g.roles, "inspector"] } : g)) }) });
    const authority = await loadAuthority(JSON.stringify(world.signedAuthority), { anchors: world.anchors });
    const ctx = { ...lab.ctx("printed-part", lab.revA, at(300)), authority };
    const L = { ...lab.ledgers["SN-0001"]!, entries: lab.ledgers["SN-0001"]!.entries.slice(0, 13) };
    const insp = lab.ledgers["SN-0001"]!.entries[13]!.record as { data: never; evidence: never };
    // The SN-0001 ledger was made under the original authority; the test authority has the same id and serial.
    await expect(appendRecord(L, ctx, lab.world.keys.planner!, { action: "inspect", role: "inspector", outcome: "accept", unit: { serial: "SN-0001" }, reason: "x", data: insp.data, evidence: insp.evidence }))
      .rejects.toThrow(/different organization than complete-build/);
  });

  it("refuses re-delegation: delegated authority can't be passed on", async () => {
    const L = { ...lab.ledgers["SN-0001"]!, entries: lab.ledgers["SN-0001"]!.entries.slice(0, 11) };
    await expect(appendRecord(L, lab.ctx("printed-part", lab.revA, at(158)), lab.world.keys.operator2!, {
      action: "delegate", role: "operator", outcome: "issued", reason: "x",
      data: { kind: "delegation", subject: lab.world.keys.outsider!.keyId, organization: ORG.cell, role: "operator", processes: ["printed-part"], notBefore: iso(158), notAfter: iso(200) },
    })).rejects.toThrow(/can't be delegated again/);
  });
});

describe("process definitions", () => {
  it("reject internal inconsistencies", () => {
    const p = printedPartProcess();
    p.transitions[0]!.roles = ["nobody"];
    p.transitions[1]!.outcomes = { accept: "nowhere" };
    const problems = validateProcess(p);
    expect(problems.join("\n")).toMatch(/undeclared role nobody/);
    expect(problems.join("\n")).toMatch(/can't have outcome accept/);
    expect(problems.join("\n")).toMatch(/unknown state nowhere/);
  });

  it("are pinned by digest: a one-byte change is a different process", async () => {
    const bytes = utf8.decode(lab.world.processes[0]!.bytes).replace('"title": "Printed part: bounded', '"title": "Printed part:  bounded');
    const changed = await loadProcess(bytes);
    const r = await verifyLedger(lab.ledgers["SN-0001"]!, { ...lab.ctx("printed-part", lab.revA), process: changed });
    expect(r.verdict).toBe("rejected");
  });
});

describe("inspection decision rules", () => {
  const ch = (rule: Characteristic["decisionRule"], extra: Partial<Characteristic> = {}): Characteristic =>
    ({ id: "C", requirement: "R", item: { itemId: "I", revision: "A" }, name: "c", unit: "mm", nominal: 10, lower: 9.9, upper: 10.1, decisionRule: rule, ...extra });
  const m = (value: number, extra: Partial<Measurement> = {}): Measurement => ({
    characteristic: "C", value, unit: "mm", method: "m", instrument: { id: "I1", description: "d", calibrationEvidence: "EV", calibrationValidUntil: "2027-01-01T00:00:00Z" },
    uncertainty: { expanded: 0.01, k: 2, unit: "mm", basis: "b" }, measuredAt: "2026-11-10T00:00:00Z", ...extra,
  });
  const run1 = (c: Characteristic, x: Measurement, ev = new Set(["EV"])) => evaluateInspection([c], [x], ev).outcome;

  it("guard-banded: accept inside the band, indeterminate within U of a limit, reject beyond U", () => {
    expect(run1(ch("guard-banded"), m(10.09))).toBe("accept");
    expect(run1(ch("guard-banded"), m(10.095))).toBe("indeterminate");
    expect(run1(ch("guard-banded"), m(10.11))).toBe("indeterminate");
    expect(run1(ch("guard-banded"), m(10.111))).toBe("reject");
    expect(run1(ch("guard-banded"), m(9.89))).toBe("indeterminate");
  });

  it("simple acceptance needs an adequate test uncertainty ratio", () => {
    expect(run1(ch("simple-acceptance"), m(10.099))).toBe("accept");
    expect(run1(ch("simple-acceptance"), m(10.101))).toBe("reject");
    expect(run1(ch("simple-acceptance"), m(10.0, { uncertainty: { expanded: 0.05, k: 2, unit: "mm", basis: "b" } }))).toBe("indeterminate");
  });

  it("holds, never passes, on missing or incompatible evidence", () => {
    expect(run1(ch("guard-banded"), m(10, { uncertainty: undefined }))).toBe("indeterminate");
    expect(run1(ch("guard-banded"), m(10, { instrument: undefined }))).toBe("indeterminate");
    expect(run1(ch("guard-banded"), m(10, { instrument: { id: "I1", description: "d", calibrationEvidence: "EV", calibrationValidUntil: "2025-01-01T00:00:00Z" } }))).toBe("indeterminate");
    expect(run1(ch("guard-banded"), m(10), new Set())).toBe("indeterminate");
    expect(run1(ch("guard-banded"), m(10, { unit: "g" }))).toBe("indeterminate");
    expect(evaluateInspection([ch("guard-banded")], [], new Set()).outcome).toBe("indeterminate");
    expect(run1(ch("guard-banded"), m(10000, { unit: "um", uncertainty: { expanded: 10, k: 2, unit: "um", basis: "b" } }))).toBe("accept");
  });
});

describe("process suitability", () => {
  it("is not-suitable for a material mismatch or a part that doesn't fit, whatever else passes", () => {
    const sn1 = run.results["SN-0001"]!.records.find((r) => r.record.data.kind === "suitability")!.record;
    if (sn1.data.kind !== "suitability") throw new Error();
    const ids = new Set(sn1.evidence.map((e) => e.id));
    const base = { ...sn1.data.input, resource: { ...sn1.data.input.resource, firmware: "x" } };
    expect(evaluateSuitability(lab.revA.model, sn1.item, base, sn1.at, ids).outcome).toBe("suitable");
    expect(evaluateSuitability(lab.revA.model, sn1.item, { ...base, material: { name: "PLA" } }, sn1.at, ids).outcome).toBe("not-suitable");
    expect(evaluateSuitability(lab.revA.model, sn1.item, { ...base, resource: { ...base.resource, buildVolumeMm: [30, 30, 30] } }, sn1.at, ids).outcome).toBe("not-suitable");
    expect(evaluateSuitability(lab.revA.model, sn1.item, { ...base, capabilities: [] }, sn1.at, ids).outcome).toBe("review-required");
  });
});

describe("ledger integrity", () => {
  it("detects a forked history against a checkpoint", async () => {
    const forked = await setupLab();
    await buildLedgers(forked);
    const cp = run.checkpoint;
    // Same instance id, but a different record 16 (different time): head differs.
    const L = JSON.parse(JSON.stringify(lab.ledgers["SN-0001"])) as LedgerFile;
    L.entries.pop();
    const r = await verifyLedger(L, lab.ctx("printed-part", lab.revA));
    const again = await appendRecord(L, lab.ctx("printed-part", lab.revA, at(400)), lab.world.keys["config-mgr"]!, {
      action: "close-evidence", role: "configuration-manager", outcome: "closed", unit: { serial: "SN-0001" }, reason: "rewritten", data: { kind: "closure", summary: "rewritten" },
    }, { recordId: await uuidFor("fork") });
    expect(r.verdict).toBe("verified");
    expect(checkCheckpoint(await verifyLedger(again.ledger, lab.ctx("printed-part", lab.revA)), cp)).toMatch(/rewritten or forked/);
  });

  it("never throws on a mangled ledger and never verifies one", async () => {
    const text = JSON.stringify(lab.ledgers["SN-0002"]);
    let seed = 7;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let i = 0; i < 60; i++) {
      const pos = rand(text.length);
      const mutated = text.slice(0, pos) + String.fromCharCode(33 + rand(90)) + text.slice(pos + 1);
      if (mutated === text) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(mutated); } catch { continue; }
      const r = await verifyLedger(parsed, lab.ctx("printed-part", lab.revA));
      if (r.verdict !== "rejected") expect(canonicalJson(parsed)).toBe(canonicalJson(JSON.parse(text)));
    }
  });

  it("is independent of key order and whitespace in the stored file", async () => {
    const L = lab.ledgers["SN-0001"]!;
    const reverse = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(reverse) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverse(x)])) : v;
    const reordered = JSON.stringify(reverse(L), null, 7);
    expect(reordered).not.toBe(JSON.stringify(L, null, 2));
    expect((await verifyLedger(JSON.parse(reordered), lab.ctx("printed-part", lab.revA))).verdict).toBe("verified");
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
  });
});

describe("exchange", () => {
  it("builds deterministic transaction ids and refuses mismatched acknowledgements", async () => {
    const recipe = await labRecipe(lab);
    const adapter = new LocalFixtureAdapter(fixtureSource(lab));
    const { baselineFrom } = await import("../src/core/records");
    const a = await buildProposals(recipe, baselineFrom(lab.revA.result), run.results["SN-0001"]!, adapter.describe(), { now: at(0) });
    const b = await buildProposals(recipe, baselineFrom(lab.revA.result), run.results["SN-0001"]!, adapter.describe(), { now: at(0) });
    expect(a.transactions.map((t) => t.txId)).toEqual(b.transactions.map((t) => t.txId));
    const acks = await adapter.reconcile(a, at(0));
    const imported = await importAcknowledgements(a, acks);
    expect(imported.problems).toEqual([]);
    expect(imported.versions[`AsBuiltUnit/${PART}:SN-0001`]).toBe(3);
    const other = await importAcknowledgements({ ...a, generatedAt: iso(5) }, acks);
    expect(other.problems.join()).toMatch(/different proposal set/);
  });

  it("refuses to build proposals against the wrong baseline", async () => {
    const recipe = await labRecipe(lab);
    const { baselineFrom } = await import("../src/core/records");
    await expect(buildProposals(recipe, baselineFrom(lab.revB.result), run.results["SN-0001"]!, new LocalFixtureAdapter(fixtureSource(lab)).describe())).rejects.toThrow(/recipe doesn't fit/);
  });
});

describe("evidence bundle", () => {
  it("keeps the four statuses separate and contains no key material", () => {
    const b = run.bundle;
    expect(Object.keys(b.status)).toEqual(["packageIntegrity", "sourceRelease", "operation", "inspection", "disposition"]);
    expect(b.status.sourceRelease).toMatch(/laboratory fixture/);
    expect(b.limitations.join(" ")).toMatch(/not when/);
    const text = JSON.stringify(b);
    expect(text).not.toMatch(/privateKey|pkcs8|passphrase|accessCode|"d":/);
    expect(b.records.every((r) => r.evidence.every((e) => e.hashVerified))).toBe(true);
    expect(b.traceability.flatMap((t) => t.characteristics).every((c) => c.result === "accept")).toBe(true);
  });
});

describe("CLI workflow commands", () => {
  it("load the committed lab files and record a step through the same gate", async () => {
    const c = await loadContext({
      package: "samples/lab/SYN-PH-2000_A.tdp", trust: "samples/lab/trust-store.signed.json", anchors: "samples/lab/anchors.json",
      authority: "samples/lab/authority.signed.json", process: "samples/lab/processes/printed-part-v1.json", evidenceDir: "samples/lab/evidence", at: "2026-11-11T09:00:00Z",
    });
    expect(c.notes.join("\n")).toMatch(/LABORATORY FIXTURE/);
    const L = newLedger(c.ctx, { itemId: PART, revision: "A" });
    const data = JSON.stringify({ kind: "requirements-approval", requirements: [{ id: "REQ-001", version: 1 }, { id: "REQ-002", version: 1 }, { id: "REQ-003", version: 1 }] });
    const out = await addRecord(L, c, lab.world.keys["req-owner"]!, { action: "approve-requirements", role: "requirement-owner", outcome: "approved", reason: "test", dataJson: data, evidence: [] });
    const r = await verifyLedger(out.ledger, c.ctx);
    expect(r.state).toBe("requirements-approved");
    expect(formatLedger(r, c).join("\n")).toMatch(/source release +Source release evidence not established/);
    await expect(addRecord(out.ledger, c, lab.world.keys.operator!, { action: "record-source-release", role: "configuration-manager", outcome: "verified", reason: "x", dataJson: '{"kind":"source-release","source":"SRC-SYN-PH-2001","system":"lab-fixture","reference":{},"revision":"A","releaseState":"Released","attestation":"lab-fixture"}', evidence: [] }))
      .rejects.toBeInstanceOf(TransitionDenied);
  });
});
