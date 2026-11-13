import { zipSync } from "fflate";
import { utf8 } from "./bytes";
import type { Mesh } from "./mesh";

/** Traceability back to the verified package, written into the 3MF so a print can be audited. */
export interface Provenance {
  title: string;
  partNumber: string;
  revision: string;
  packageId: string;
  manifestSha256: string;
  sourcePath: string;
  sourceSha256: string;
  exportedAt: string;
  targetPrinter?: string;
  targetPrinterFirmware?: string;
}

const xml = (s: string) =>
  s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
const n = (v: number) => (Math.round(v * 1e6) / 1e6).toString();

/**
 * Writes a 3MF core-spec package (one object per mesh, all on the build plate).
 * Bambu Studio and other slicers open it directly.
 */
export function write3mf(meshes: Mesh[], provenance: Provenance): Uint8Array {
  const objects = meshes
    .map((m, i) => {
      const verts: string[] = [];
      for (let v = 0; v < m.positions.length; v += 3)
        verts.push(`<vertex x="${n(Number(m.positions[v]))}" y="${n(Number(m.positions[v + 1]))}" z="${n(Number(m.positions[v + 2]))}"/>`);
      const tris: string[] = [];
      for (let t = 0; t < m.indices.length; t += 3)
        tris.push(`<triangle v1="${m.indices[t]}" v2="${m.indices[t + 1]}" v3="${m.indices[t + 2]}"/>`);
      return `<object id="${i + 1}" name="${xml(m.name)}" type="model"><mesh><vertices>${verts.join("")}</vertices><triangles>${tris.join("")}</triangles></mesh></object>`;
    })
    .join("\n    ");
  const items = meshes.map((_, i) => `<item objectid="${i + 1}"/>`).join("");
  const p = provenance;
  const meta: [string, string][] = [
    ["Title", `${p.title} (${p.partNumber} rev ${p.revision})`],
    ["Application", "tdp-viewer"],
    ["CreationDate", p.exportedAt],
    ["tdp:PartNumber", p.partNumber],
    ["tdp:Revision", p.revision],
    ["tdp:PackageId", p.packageId],
    ["tdp:ManifestSha256", p.manifestSha256],
    ["tdp:SourcePath", p.sourcePath],
    ["tdp:SourceSha256", p.sourceSha256],
    ...(p.targetPrinter ? [["tdp:TargetPrinter", p.targetPrinter] as [string, string]] : []),
    ...(p.targetPrinter && p.targetPrinterFirmware ? [["tdp:TargetPrinterFirmware", p.targetPrinterFirmware] as [string, string]] : []),
  ];

  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:tdp="urn:tdp-viewer:provenance:0.1">
  ${meta.map(([k, v]) => `<metadata name="${k}">${xml(v)}</metadata>`).join("\n  ")}
  <resources>
    ${objects}
  </resources>
  <build>${items}</build>
</model>
`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>
`;
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;
  return zipSync({
    "[Content_Types].xml": utf8.encode(contentTypes),
    "_rels/.rels": utf8.encode(rels),
    "3D/3dmodel.model": utf8.encode(model),
  });
}
