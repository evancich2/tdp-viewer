import type { BomItem, Manifest, ManifestFile } from "./schema";

export type FileChange =
  | { kind: "added"; file: ManifestFile }
  | { kind: "removed"; file: ManifestFile }
  | { kind: "changed"; before: ManifestFile; after: ManifestFile }
  | { kind: "moved"; before: ManifestFile; after: ManifestFile }
  /** Same part and role, new file: e.g. the drawing for SMP-1002 rev C replaced by rev D. */
  | { kind: "revised"; before: ManifestFile; after: ManifestFile };

export type BomChange =
  | { kind: "added"; item: BomItem }
  | { kind: "removed"; item: BomItem }
  | { kind: "changed"; before: BomItem; after: BomItem; fields: string[] };

export interface FieldChange {
  field: string;
  before: string | undefined;
  after: string | undefined;
}

export interface PackageDiff {
  package: FieldChange[];
  files: FileChange[];
  unchangedFiles: number;
  bom: BomChange[];
}

/**
 * What changed between two manifests. Files are matched by path, then by digest (a rename shows as
 * moved), then by part number and role (a new revision of a document shows as revised).
 * BOM items are matched by part number.
 */
export function diffManifests(before: Manifest, after: Manifest): PackageDiff {
  const pkgFields = ["title", "partNumber", "revision", "expires", "distribution"] as const;
  const pkg = pkgFields
    .map((field) => ({ field, before: before.package[field], after: after.package[field] }))
    .filter((c) => c.before !== c.after);

  const beforeByPath = new Map(before.files.map((f) => [f.path, f]));
  const afterByPath = new Map(after.files.map((f) => [f.path, f]));
  const files: FileChange[] = [];
  let unchangedFiles = 0;

  for (const a of after.files) {
    const b = beforeByPath.get(a.path);
    if (!b) continue;
    if (b.sha256 === a.sha256 && b.mediaType === a.mediaType && b.role === a.role) unchangedFiles++;
    else files.push({ kind: "changed", before: b, after: a });
  }
  const removed = before.files.filter((f) => !afterByPath.has(f.path));
  const added = after.files.filter((f) => !beforeByPath.has(f.path));
  const unmatched: ManifestFile[] = [];
  for (const a of added) {
    const i = removed.findIndex((r) => r.sha256 === a.sha256);
    if (i >= 0) files.push({ kind: "moved", before: removed.splice(i, 1)[0]!, after: a });
    else unmatched.push(a);
  }
  for (const a of unmatched) {
    const i = a.partNumber ? removed.findIndex((r) => r.partNumber === a.partNumber && r.role === a.role) : -1;
    if (i >= 0) files.push({ kind: "revised", before: removed.splice(i, 1)[0]!, after: a });
    else files.push({ kind: "added", file: a });
  }
  for (const r of removed) files.push({ kind: "removed", file: r });

  const beforeBom = new Map(before.bom.map((i) => [i.partNumber, i]));
  const afterBom = new Map(after.bom.map((i) => [i.partNumber, i]));
  const bom: BomChange[] = [];
  for (const a of after.bom) {
    const b = beforeBom.get(a.partNumber);
    if (!b) {
      bom.push({ kind: "added", item: a });
      continue;
    }
    const fields = (["revision", "name", "quantity", "parent"] as const).filter((k) => b[k] !== a[k]) as string[];
    if ([...b.files].sort().join("\n") !== [...a.files].sort().join("\n")) fields.push("files");
    if (fields.length) bom.push({ kind: "changed", before: b, after: a, fields });
  }
  for (const b of before.bom) if (!afterBom.has(b.partNumber)) bom.push({ kind: "removed", item: b });

  return { package: pkg, files, unchangedFiles, bom };
}

/** Plain-text report, used by the CLI. */
export function formatDiff(d: PackageDiff): string {
  const lines: string[] = [];
  for (const c of d.package) lines.push(`package ${c.field}: ${c.before ?? "—"} → ${c.after ?? "—"}`);
  for (const c of d.files) {
    if (c.kind === "added") lines.push(`+ ${c.file.path}`);
    else if (c.kind === "removed") lines.push(`- ${c.file.path}`);
    else if (c.kind === "moved") lines.push(`> ${c.before.path} → ${c.after.path} (same content)`);
    else if (c.kind === "revised")
      lines.push(`~ ${c.before.path} → ${c.after.path} (${c.after.role} for ${c.after.partNumber}, rev ${c.before.revision ?? "—"} → ${c.after.revision ?? "—"})`);
    else lines.push(`~ ${c.after.path} (content changed)`);
  }
  for (const c of d.bom) {
    if (c.kind === "added") lines.push(`+ part ${c.item.partNumber} rev ${c.item.revision} ${c.item.name} × ${c.item.quantity}`);
    else if (c.kind === "removed") lines.push(`- part ${c.item.partNumber} rev ${c.item.revision} ${c.item.name}`);
    else
      lines.push(
        `~ part ${c.after.partNumber}: ` +
          c.fields
            .map((f) => (f === "files" ? "files" : `${f} ${String(c.before[f as keyof BomItem] ?? "—")} → ${String(c.after[f as keyof BomItem] ?? "—")}`))
            .join(", "),
      );
  }
  lines.push(`${d.unchangedFiles} files unchanged`);
  return lines.join("\n");
}
