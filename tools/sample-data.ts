// Synthetic sample content for demos and tests. All part numbers, names and geometry are made up.
import { utf8 } from "../src/core/bytes";
import type { BomItem } from "../src/core/schema";
import type { PackInput } from "../src/core/pack";

/** A minimal one-page PDF with correct xref offsets, drawn as a fake title block. */
export function samplePdf(title: string, partNumber: string, revision: string): Uint8Array {
  const text = (x: number, y: number, size: number, s: string) =>
    `BT /F1 ${size} Tf ${x} ${y} Td (${s.replace(/[()\\]/g, "\\$&")}) Tj ET`;
  const content = [
    "1 w 36 36 720 540 re S",
    "36 96 m 756 96 l S 456 36 m 456 96 l S",
    text(48, 72, 14, title),
    text(48, 50, 10, "SAMPLE DATA - NOT A REAL PART"),
    text(468, 72, 12, `P/N ${partNumber}`),
    text(468, 50, 12, `REV ${revision}`),
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

/** A placeholder STEP AP242 file: valid header, a product definition, no geometry yet. */
export function sampleStep(name: string, partNumber: string): Uint8Array {
  return utf8.encode(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Synthetic sample part'),'2;1');
FILE_NAME('${partNumber}.stp','2026-01-01T00:00:00',('tdp-viewer'),(''),'','','');
FILE_SCHEMA(('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF'));
ENDSEC;
DATA;
#1=APPLICATION_CONTEXT('managed model based 3d engineering');
#2=PRODUCT('${partNumber}','${name}','',(#3));
#3=PRODUCT_CONTEXT('',#1,'mechanical');
ENDSEC;
END-ISO-10303-21;
`);
}

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
      { path: drawing, bytes: samplePdf(p.name, p.pn, p.rev), mediaType: "application/pdf", role: "drawing", partNumber: p.pn, revision: p.rev },
      { path: model, bytes: sampleStep(p.name, p.pn), mediaType: "model/step", role: "model", partNumber: p.pn, revision: p.rev },
    );
    bom.push({ partNumber: p.pn, revision: p.rev, name: p.name, quantity: p.qty, parent: p.parent, files: [drawing, model] });
  }
  const csv = ["part_number,revision,name,quantity,parent", ...parts.map((p) => `${p.pn},${p.rev},${p.name},${p.qty},${p.parent ?? ""}`)].join("\n");
  inputs.push({ path: "bom/bom.csv", bytes: utf8.encode(csv + "\n"), mediaType: "text/csv", role: "bom" });
  return { inputs, bom };
}
