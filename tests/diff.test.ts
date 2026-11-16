import { describe, expect, it } from "vitest";
import { buildManifest, diffManifests, formatDiff, type Manifest } from "../src/core";
import { sampleContents } from "../tools/sample-data";

const pkg = (revision: string): Manifest["package"] => ({
  id: "8f2d1c3a-6b4e-4f0a-9c1d-2e3f4a5b6c7d",
  title: "Sample",
  partNumber: "SMP-1000",
  revision,
  created: "2026-06-01T00:00:00.000Z",
});

async function manifest(rev: "B" | "C") {
  const { inputs, bom } = sampleContents(rev);
  return buildManifest(pkg(rev), inputs, bom);
}

describe("diffManifests", () => {
  it("reports the rev B to rev C change order precisely", async () => {
    const d = diffManifests(await manifest("B"), await manifest("C"));
    expect(d.package).toEqual([{ field: "revision", before: "B", after: "C" }]);

    const summary = d.files.map((c) => ("file" in c ? `${c.kind} ${c.file.path}` : `${c.kind} ${c.before.path} -> ${c.after.path}`)).sort();
    expect(summary).toEqual([
      "added notes/ECO-0042.txt",
      "changed bom/bom.csv -> bom/bom.csv",
      "revised drawings/SMP-1000_B.pdf -> drawings/SMP-1000_C.pdf",
      "revised drawings/SMP-1002_C.pdf -> drawings/SMP-1002_D.pdf",
      "revised models/SMP-1000_B.stp -> models/SMP-1000_C.stp",
      "revised models/SMP-1002_C.stp -> models/SMP-1002_D.stp",
    ]);
    expect(d.unchangedFiles).toBe(2); // the bracket's drawing and model

    const bom = Object.fromEntries(d.bom.map((c) => [c.kind === "changed" ? c.after.partNumber : c.item.partNumber, c]));
    expect(Object.keys(bom).sort()).toEqual(["SMP-1000", "SMP-1002"]);
    expect(bom["SMP-1002"]).toMatchObject({ kind: "changed", fields: ["revision", "files"] });
  });

  it("shows a renamed file with the same content as moved", async () => {
    const before = await manifest("B");
    const after = structuredClone(before);
    after.files[0]!.path = "drawings/renamed.pdf";
    const d = diffManifests(before, after);
    expect(d.files).toEqual([{ kind: "moved", before: before.files[0], after: after.files[0] }]);
  });

  it("reports nothing for identical manifests", async () => {
    const m = await manifest("B");
    const d = diffManifests(m, m);
    expect(d.files).toEqual([]);
    expect(d.bom).toEqual([]);
    expect(formatDiff(d)).toBe(`${m.files.length} files unchanged`);
  });
});

describe("diffManifests edge cases and formatDiff", () => {
  const file = (path: string, sha: string, extra: Partial<Manifest["files"][number]> = {}): Manifest["files"][number] =>
    ({ path, sha256: sha.repeat(64), size: 1, mediaType: "application/pdf", role: "drawing", ...extra });
  const item = (partNumber: string, extra: Partial<Manifest["bom"][number]> = {}): Manifest["bom"][number] =>
    ({ partNumber, revision: "A", name: partNumber, quantity: 1, files: [], ...extra });
  const m = (files: Manifest["files"], bom: Manifest["bom"] = [], p: Partial<Manifest["package"]> = {}) =>
    ({ schema: "tdp-manifest/0.1", package: { ...pkg("A"), ...p }, files, bom }) as Manifest;

  it("prefers moved (same digest) over revised (same part and role), and needs a part number to revise", () => {
    const before = m([file("a.pdf", "1", { partNumber: "P-1", revision: "A" }), file("b.pdf", "2", { partNumber: "P-2", revision: "A" }), file("c.pdf", "3")]);
    const after = m([file("a2.pdf", "1", { partNumber: "P-1", revision: "A" }), file("b2.pdf", "9", { partNumber: "P-2", revision: "B" }), file("c2.pdf", "8")]);
    const kinds = diffManifests(before, after).files.map((c) => c.kind === "added" || c.kind === "removed" ? `${c.kind} ${c.file.path}` : `${c.kind} ${c.before.path}->${c.after.path}`);
    expect(kinds).toEqual(["moved a.pdf->a2.pdf", "revised b.pdf->b2.pdf", "added c2.pdf", "removed c.pdf"]);
  });

  it("treats a role or media type change at the same path as changed, and a role change as blocking revision", () => {
    const d = diffManifests(m([file("a.pdf", "1"), file("x.pdf", "2", { partNumber: "P", role: "drawing" })]),
      m([file("a.pdf", "1", { role: "spec" }), file("y.pdf", "3", { partNumber: "P", role: "spec" })]));
    expect(d.files.map((c) => c.kind)).toEqual(["changed", "added", "removed"]);
    expect(d.unchangedFiles).toBe(0);
  });

  it("reports package fields, BOM additions, removals and field changes, with file lists compared as sets", () => {
    const before = m([file("a.pdf", "1")], [item("P-1", { files: ["a.pdf", "b.pdf"] }), item("P-2"), item("P-3", { quantity: 2, parent: "P-1" })], { distribution: "A" });
    const after = m([file("a.pdf", "1")], [item("P-1", { files: ["b.pdf", "a.pdf"] }), item("P-3", { quantity: 3 }), item("P-4")], { expires: "2027-01-01T00:00:00Z", distribution: undefined });
    const d = diffManifests(before, after);
    expect(d.package).toEqual([{ field: "expires", before: undefined, after: "2027-01-01T00:00:00Z" }, { field: "distribution", before: "A", after: undefined }]);
    expect(d.bom.map((c) => c.kind === "changed" ? `changed ${c.after.partNumber} ${c.fields.join(",")}` : `${c.kind} ${c.item.partNumber}`))
      .toEqual(["changed P-3 quantity,parent", "added P-4", "removed P-2"]);
    expect(formatDiff(d).split("\n")).toEqual([
      "package expires: — → 2027-01-01T00:00:00Z",
      "package distribution: A → —",
      "~ part P-3: quantity 2 → 3, parent P-1 → —",
      "+ part P-4 rev A P-4 × 1",
      "- part P-2 rev A P-2",
      "1 files unchanged",
    ]);
  });

  it("writes one line per kind of file change", () => {
    const d = diffManifests(
      m([file("same.pdf", "1"), file("old.pdf", "2"), file("rev.pdf", "3", { partNumber: "P", revision: "A" }), file("gone.pdf", "4"), file("edit.pdf", "5")], [item("P", { files: ["rev.pdf"] })]),
      m([file("same.pdf", "1"), file("new-name.pdf", "2"), file("rev-b.pdf", "6", { partNumber: "P", revision: "B" }), file("fresh.pdf", "7"), file("edit.pdf", "0")], [item("P", { files: ["rev-b.pdf"] })]),
    );
    expect(formatDiff(d).split("\n")).toEqual([
      "~ edit.pdf (content changed)",
      "> old.pdf → new-name.pdf (same content)",
      "~ rev.pdf → rev-b.pdf (drawing for P, rev A → B)",
      "+ fresh.pdf",
      "- gone.pdf",
      "~ part P: files",
      "1 files unchanged",
    ]);
  });
});
