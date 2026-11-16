import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { utf8 } from "../src/core/bytes";
import { buildManifest, buildPackage } from "../src/core/pack";
import { defaultPolicy } from "../src/core/policy";
import {
  ReferenceSet,
  reviewReferences,
  type ReferenceTarget,
} from "../src/core/references";
import {
  baselineFrom,
  evaluateRecord,
  nextActions,
  verifyLedger,
  type LedgerResult,
} from "../src/core/records";
import { ManifestV02 } from "../src/core/schema";
import { verifyPackage, type VerifyResult } from "../src/core/verify";
import { buildWorld } from "../tools/lab-fixtures";
import {
  loadContext,
  readLedger,
  type LoadedContext,
} from "../tools/workflow-commands";
let c: LoadedContext,
  w: Awaited<ReturnType<typeof buildWorld>>,
  ledger: LedgerResult,
  target: ReferenceTarget;
beforeAll(async () => {
  c = await loadContext({
    package: "samples/lab/SYN-PH-2000_A.tdp",
    trust: "samples/lab/trust-store.signed.json",
    anchors: "samples/lab/anchors.json",
    authority: "samples/lab/authority.signed.json",
    process: "samples/lab/processes/printed-part-v1.json",
    evidenceDir: "samples/lab/evidence",
    at: "2026-11-12T13:00:00Z",
  });
  w = await buildWorld();
  ledger = await verifyLedger(
    readLedger("samples/lab/ledgers/SN-0001.ledger.json"),
    c.ctx,
  );
  target = {
    kind: "baseline",
    packageId: c.ctx.baseline.packageId,
    manifestSha256: c.ctx.baseline.manifestSha256,
    baselineId: c.ctx.baseline.model.baseline.id,
  };
});
const ref = (t: ReferenceTarget = target) => ({
  id: "SYNTH-REF",
  relationship: "describes",
  purpose: "Synthetic local identity review only",
  target: t,
  tags: ["unknown-descriptive-tag"],
});
async function make(set: unknown) {
  const m = c.verify.manifest!;
  if (m.schema === "tdp-manifest/0.1")
    throw new Error("expected engineering fixture");
  const inputs = m.files.map((f) => ({
    ...f,
    bytes: c.verify.entries.find((e) => e.path === f.path)!.bytes,
  }));
  inputs.push({
    path: "references.json",
    bytes: utf8.encode(JSON.stringify(set)),
    mediaType: "application/json",
    role: "spec",
    size: 0,
    sha256: "",
  });
  const tdp = await buildPackage(
    m.package,
    inputs,
    m.bom,
    [
      { ...w.keys.author!, role: "author" },
      { ...w.keys.approver!, role: "approver" },
    ],
    c.ctx.now,
    { engineering: m.engineering.path, references: "references.json" },
  );
  return {
    tdp,
    result: await verifyPackage(
      tdp,
      c.ctx.trustStore,
      defaultPolicy,
      c.ctx.now,
    ),
  };
}
const set = (references: unknown[]) => ({
  schema: "tdp-references/0.1",
  references,
});
describe("signed opt-in cross-package references", () => {
  it("round-trips signed references and makes older strict parsers reject the new profile", async () => {
    const { result } = await make(set([ref()]));
    expect(result.verdict).toBe("trusted");
    expect(result.manifest!.schema).toBe("tdp-manifest/0.3");
    expect(result.references!.references[0]!.tags).toEqual([
      "unknown-descriptive-tag",
    ]);
    expect(ManifestV02.safeParse(result.manifest).success).toBe(false);
    expect(reviewReferences(result, [c.verify])).toEqual([
      { id: "SYNTH-REF", status: "matched", reasons: [], authorized: false },
    ]);
  });
  it("rejects duplicate identities, unknown fields and missing reference files", async () => {
    for (const value of [
      set([ref(), ref()]),
      { ...set([]), unexpected: true },
      set([{ ...ref(), latest: true }]),
    ])
      expect((await make(value)).result.verdict).toBe("rejected");
    const m = c.verify.manifest!;
    await expect(buildManifest(m.package, [], [], { references: "" })).rejects.toThrow(/must not be empty/);
    await expect(
      buildManifest(m.package, [], [], { references: "refs.json" }),
    ).rejects.toThrow(/engineering/);
    await expect(
      buildManifest(
        m.package,
        [
          {
            path: "model.json",
            bytes: utf8.encode("{}"),
            mediaType: "application/json",
            role: "spec",
          },
        ],
        [],
        { engineering: "model.json", references: "missing" },
      ),
    ).rejects.toThrow(/not among/);
    await expect(
      buildManifest(
        m.package,
        [
          {
            path: "model.json",
            bytes: utf8.encode("{}"),
            mediaType: "application/json",
            role: "spec",
          },
        ],
        [],
        { engineering: "model.json", references: "model.json" },
      ),
    ).rejects.toThrow(/distinct/);
  });
  it("rejects tampered reference bytes under the unchanged digest", async () => {
    const { tdp } = await make(set([ref()]));
    const files = unzipSync(tdp);
    files["references.json"] = utf8.encode(JSON.stringify(set([])));
    expect(
      (
        await verifyPackage(
          zipSync(files),
          c.ctx.trustStore,
          defaultPolicy,
          c.ctx.now,
        )
      ).verdict,
    ).toBe("rejected");
  });
  it("holds missing, wrong-digest and untrusted targets without selecting another version", async () => {
    const { result } = await make(set([ref()]));
    expect(reviewReferences(result, [])[0]!.reasons.join()).toMatch(
      /unavailable/,
    );
    const wrong = structuredClone(c.verify);
    wrong.manifestSha256 = "0".repeat(64);
    expect(reviewReferences(result, [wrong])[0]!.status).toBe("held");
    const rejected = { ...c.verify, verdict: "rejected" as const };
    expect(reviewReferences(result, [rejected])[0]!.reasons.join()).toMatch(
      /not trusted/,
    );
    expect(() => reviewReferences(rejected, [])).toThrow(
      /source is not trusted/,
    );
  });
  it("requires exact record digest, identity and verified baseline-bound ledger", async () => {
    const record = ledger.records.at(-1)!;
    const r: ReferenceTarget = {
      ...target,
      kind: "record",
      recordId: record.record.recordId,
      recordSha256: record.sha256,
    };
    const { result } = await make(set([ref(r)]));
    expect(reviewReferences(result, [c.verify])[0]!.status).toBe("held");
    expect(reviewReferences(result, [c.verify], [ledger])[0]!.status).toBe(
      "matched",
    );
    expect(
      reviewReferences(result, [c.verify], [{ ...ledger, verdict: "held" }])[0]!
        .status,
    ).toBe("held");
    const wrong = structuredClone(ledger);
    wrong.instance!.manifestSha256 = "0".repeat(64);
    expect(reviewReferences(result, [c.verify], [wrong])[0]!.status).toBe(
      "held",
    );
  });
  it("retains modified versions but keeps change requests held for authorized resolution", async () => {
    const { result } = await make(set([{ ...ref(), tags: ["modified"] }]));
    expect(result.verdict).toBe("trusted");
    expect(reviewReferences(result, [c.verify])[0]!.reasons.join()).toMatch(
      /needs a reason/,
    );
    const record = ledger.records.at(-1)!;
    const request: ReferenceTarget = {
      ...target,
      kind: "record",
      recordId: record.record.recordId,
      recordSha256: record.sha256,
    };
    const modified = await make(
      set([
        {
          ...ref(),
          tags: ["modified"],
          change: {
            reason: "Synthetic machinability change",
            predecessor: target,
            request,
          },
        },
      ]),
    );
    expect(
      reviewReferences(
        modified.result,
        [c.verify],
        [ledger],
      )[0]!.reasons.join(),
    ).toMatch(/must differ.*authorized recorded resolution/);
    expect(
      ReferenceSet.safeParse(
        set([
          { ...ref(), change: { reason: "", predecessor: target, request } },
        ]),
      ).success,
    ).toBe(false);
  });
  it("denies new-work signing and next-action authorization even when identities match", async () => {
    const { result } = await make(set([ref()]));
    const baseline = baselineFrom(result);
    const record = structuredClone(ledger.records[4]!.record);
    record.baseline.manifestSha256 = baseline.manifestSha256;
    const ctx = { ...c.ctx, baseline };
    expect(
      evaluateRecord(ledger.records.slice(0, 4), record, ctx, "create").fatal,
    ).toMatch(/policy-aware engineering review/);
    expect(
      evaluateRecord(
        ledger.records.slice(0, 4),
        record,
        ctx,
        "verify",
      ).held.join(),
    ).toMatch(/policy-aware/);
    const partial = {
      ...ledger,
      records: ledger.records.slice(0, 4),
      state: "process-qualified",
      instanceState: "process-qualified",
      units: [],
    };
    const actions = nextActions(partial, ctx);
    expect(
      actions.find((a) => a.transition === "plan-build")?.blockedBy.join(),
    ).toMatch(/policy-aware/);
  });
  it("bounds graph traversal and reports cycles, supersession and conflicts", async () => {
    const { result } = await make(set([ref()]));
    // Synthetic verifier-result graph fixtures test aggregation only, not cryptographic verification.
    const cycle = structuredClone(c.verify);
    cycle.references = ReferenceSet.parse(set([ref(target)]));
    expect(reviewReferences(result, [cycle])[0]!.reasons.join()).toMatch(
      /cycle/,
    );
    const deep = structuredClone(c.verify);
    deep.references = ReferenceSet.parse(
      set([ref({ ...target, manifestSha256: "4".repeat(64) })]),
    );
    expect(reviewReferences(result, [deep], [], 1)[0]!.reasons.join()).toMatch(
      /depth/,
    );
    const successor = structuredClone(c.verify);
    successor.manifestSha256 = "1".repeat(64);
    successor.engineering!.model.baseline.supersedes = {
      packageId: target.packageId,
      manifestSha256: target.manifestSha256,
      baselineId: target.baselineId,
    };
    expect(
      reviewReferences(result, [c.verify, successor])[0]!.reasons.join(),
    ).toMatch(/superseded/);
    const conflict = structuredClone(c.verify);
    conflict.manifestSha256 = "2".repeat(64);
    conflict.engineering!.model.artifacts.find((a) => a.authoritative)!.sha256 =
      "3".repeat(64);
    expect(
      reviewReferences(result, [c.verify, conflict])[0]!.reasons.join(),
    ).toMatch(/conflicting/);
    for (const depth of [0, 33, NaN])
      expect(() => reviewReferences(result, [], [], depth)).toThrow(/depth/);
    expect(() =>
      reviewReferences(result, Array<VerifyResult>(129).fill(c.verify)),
    ).toThrow(/128/);
    const wide = structuredClone(c.verify);
    wide.references = ReferenceSet.parse(
      set(
        Array.from({ length: 128 }, (_, i) => ({
          ...ref(),
          id: `R-${i}`,
          target: { ...target, manifestSha256: "4".repeat(64) },
        })),
      ),
    );
    const leaf = structuredClone(c.verify);
    leaf.manifestSha256 = "4".repeat(64);
    const many = structuredClone(result);
    many.references = ReferenceSet.parse(
      set(Array.from({ length: 128 }, (_, i) => ({ ...ref(), id: `S-${i}` }))),
    );
    expect(
      reviewReferences(many, [wide, leaf]).some((r) =>
        r.reasons.join().includes("budget"),
      ),
    ).toBe(true);
  });
  it("runs the read-only CLI with exact local files and reports holds with exit 2", async () => {
    const { tdp } = await make(set([ref()]));
    const dir = mkdtempSync(join(tmpdir(), "tdp-reference-test-")),
      path = join(dir, "source.tdp");
    writeFileSync(path, tdp);
    const args = [
      "--import",
      "tsx",
      "tools/references.ts",
      "--source",
      path,
      "--trust",
      "samples/lab/trust-store.signed.json",
      "--anchors",
      "samples/lab/anchors.json",
      "--at",
      c.ctx.now.toISOString(),
    ];
    const ok = await promisify(execFile)(process.execPath, [
      ...args,
      "--target",
      "samples/lab/SYN-PH-2000_A.tdp",
    ]);
    expect(JSON.parse(ok.stdout)).toMatchObject({
      authorized: false,
      references: [{ status: "matched" }],
    });
    const held = await promisify(execFile)(process.execPath, args).then(
      () => null,
      (e: { code: number; stdout: string }) => e,
    );
    expect(held?.code).toBe(2);
    expect(JSON.parse(held!.stdout).references[0].status).toBe("held");
  });
});
