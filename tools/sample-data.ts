// Synthetic sample content for demos and tests. All part numbers, names and geometry are made up.
import { utf8 } from "../src/core/bytes";
import type { BomItem } from "../src/core/schema";
import type { PackInput } from "../src/core/pack";
import { writeStep, type Prism } from "./step-writer";

/** A minimal one-page PDF with correct xref offsets: the part's outline, overall dimensions and a title block. */
export function samplePdf(title: string, partNumber: string, revision: string, prisms: Prism[] = []): Uint8Array {
  const text = (x: number, y: number, size: number, s: string) =>
    `BT /F1 ${size} Tf ${x} ${y} Td (${s.replace(/[()\\]/g, "\\$&")}) Tj ET`;
  const content = [
    "1 w 36 36 720 540 re S",
    "36 96 m 756 96 l S 456 36 m 456 96 l S",
    text(48, 72, 14, title),
    text(48, 50, 10, "SAMPLE DATA - NOT A REAL PART"),
    text(468, 72, 12, `P/N ${partNumber}`),
    text(468, 50, 12, `REV ${revision}`),
    ...drawView(prisms),
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return utf8.encode(out);
}

/** Plan view (XY) of the prisms at 5:1, with overall width and height dimensions. */
function drawView(prisms: Prism[]): string[] {
  if (!prisms.length) return [];
  const xs = prisms.flatMap((p) => p.outline.map(([x]) => x));
  const ys = prisms.flatMap((p) => p.outline.map(([, y]) => y));
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const scale = 5;
  const ox = 120 - x0 * scale;
  const oy = 160 - y0 * scale;
  const pt = ([x, y]: [number, number]) => `${ox + x * scale} ${oy + y * scale}`;
  const ops = ["2 w"];
  for (const p of prisms) ops.push(`${pt(p.outline[0]!)} m ${p.outline.slice(1).map((v) => `${pt(v)} l`).join(" ")} h S`);
  const w = x1 - x0;
  const h = y1 - y0;
  const [left, right, bottom, top] = [ox + x0 * scale, ox + x1 * scale, oy + y0 * scale, oy + y1 * scale];
  ops.push("0.5 w", `${left} ${bottom - 30} m ${right} ${bottom - 30} l S`, `${left - 30} ${bottom} m ${left - 30} ${top} l S`);
  ops.push(`BT /F1 10 Tf ${(left + right) / 2 - 12} ${bottom - 44} Td (${w} mm) Tj ET`);
  ops.push(`BT /F1 10 Tf ${left - 80} ${(bottom + top) / 2} Td (${h} mm) Tj ET`);
  ops.push(`BT /F1 9 Tf ${right + 40} ${top} Td (PLAN VIEW  SCALE 5:1) Tj ET`);
  const depth = Math.max(...prisms.map((p) => p.z0 + p.height)) - Math.min(...prisms.map((p) => p.z0));
  ops.push(`BT /F1 9 Tf ${right + 40} ${top - 14} Td (DEPTH ${depth} mm) Tj ET`);
  return ops;
}

// Sample geometry in millimetres: an L-shaped bracket and triangular gussets in its inside corner.
const bracket: Prism = { outline: [[0, 0], [60, 0], [60, 5], [5, 5], [5, 40], [0, 40]], z0: 0, height: 30 };
const gusset = (z0: number): Prism => ({ outline: [[5, 5], [35, 5], [5, 35]], z0, height: 4 });

const geometry: Record<string, Prism[]> = {
  "SMP-1000": [bracket, gusset(0), gusset(26)],
  "SMP-1001": [bracket],
  "SMP-1002": [gusset(0)],
};

export function sampleContents(): { inputs: PackInput[]; bom: BomItem[] } {
  const parts = [
    { pn: "SMP-1000", rev: "B", name: "Sample Bracket Assembly", qty: 1, parent: undefined },
    { pn: "SMP-1001", rev: "A", name: "Mounting Bracket", qty: 1, parent: "SMP-1000" },
    { pn: "SMP-1002", rev: "C", name: "Gusset Plate", qty: 2, parent: "SMP-1000" },
  ];
  const inputs: PackInput[] = [];
  const bom: BomItem[] = [];
  for (const p of parts) {
    const drawing = `drawings/${p.pn}_${p.rev}.pdf`;
    const model = `models/${p.pn}_${p.rev}.stp`;
    inputs.push(
      { path: drawing, bytes: samplePdf(p.name, p.pn, p.rev, geometry[p.pn]), mediaType: "application/pdf", role: "drawing", partNumber: p.pn, revision: p.rev },
      { path: model, bytes: writeStep(p.pn, p.name, geometry[p.pn]!), mediaType: "model/step", role: "model", partNumber: p.pn, revision: p.rev },
    );
    bom.push({ partNumber: p.pn, revision: p.rev, name: p.name, quantity: p.qty, parent: p.parent, files: [drawing, model] });
  }
  const csv = ["part_number,revision,name,quantity,parent", ...parts.map((p) => `${p.pn},${p.rev},${p.name},${p.qty},${p.parent ?? ""}`)].join("\n");
  inputs.push({ path: "bom/bom.csv", bytes: utf8.encode(csv + "\n"), mediaType: "text/csv", role: "bom" });
  return { inputs, bom };
}
