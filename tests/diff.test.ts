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
