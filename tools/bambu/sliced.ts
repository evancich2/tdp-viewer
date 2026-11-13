// Inspects a sliced Bambu Studio project (.gcode.3mf) before it goes to a printer: which plates
// carry G-code, the G-code's MD5 (the printer's project_file command wants it), the slicer's own
// MD5 if it wrote one, and the filaments the plate uses. Unsliced 3MFs, like the viewer's own
// export, have no G-code and are refused.
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";

export const MAX_SLICED_BYTES = 1024 * 1024 * 1024;

export interface SlicedFilament { id: number; type?: string; color?: string; usedGrams?: number }
export interface SlicedPlate {
  plate: number;
  gcodePath: string;
  gcodeBytes: number;
  gcodeMd5: string;
  /** From Metadata/plate_N.gcode.md5 when the slicer wrote one. */
  declaredMd5?: string;
  printerModelId?: string;
  nozzleDiameters?: string;
  predictionSeconds?: number;
  weightGrams?: number;
  filaments: SlicedFilament[];
}
export interface SlicedProject {
  sha256: string;
  bytes: number;
  plates: number[];
  /** Number of filaments in the whole project (the length the AMS mapping must have). */
  projectFilaments: number;
  plate: SlicedPlate;
}

export class SlicedFileError extends Error {}

const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];

function plateInfo(xml: string, plate: number) {
  for (const m of xml.matchAll(/<plate>([\s\S]*?)<\/plate>/g)) {
    const body = m[1]!;
    const meta: Record<string, string> = {};
    for (const t of body.matchAll(/<metadata\s[^>]*>/g)) { const k = attr(t[0], "key"), v = attr(t[0], "value"); if (k && v !== undefined) meta[k] = v; }
    if (Number(meta.index) !== plate) continue;
    const filaments = [...body.matchAll(/<filament\s[^>]*>/g)].map((t) => ({
      id: Number(attr(t[0], "id")),
      type: attr(t[0], "type"),
      color: attr(t[0], "color"),
      usedGrams: attr(t[0], "used_g") === undefined ? undefined : Number(attr(t[0], "used_g")),
    })).filter((f) => Number.isInteger(f.id) && f.id > 0);
    return { meta, filaments };
  }
  return undefined;
}

export function inspectSliced(bytes: Uint8Array, plate?: number): SlicedProject {
  if (bytes.byteLength > MAX_SLICED_BYTES) throw new SlicedFileError("file larger than 1 GB");
  const names: string[] = [];
  let files: Record<string, Uint8Array>;
  try {
    // First pass: names only (nothing decompressed).
    unzipSync(bytes, { filter: (f) => { names.push(f.name); return false; } });
    const plates = names.map((n) => /^Metadata\/plate_(\d+)\.gcode$/.exec(n)?.[1]).filter((x): x is string => !!x).map(Number).sort((a, b) => a - b);
    if (!plates.length) throw new SlicedFileError("no sliced plate in this 3MF (no Metadata/plate_N.gcode). Slice it in Bambu Studio and use File > Export > Export plate sliced file (.gcode.3mf).");
    const want = plate ?? (plates.length === 1 ? plates[0]! : undefined);
    if (want === undefined) throw new SlicedFileError(`this file has plates ${plates.join(", ")}; choose one with --plate`);
    if (!plates.includes(want)) throw new SlicedFileError(`plate ${want} has no G-code; sliced plates: ${plates.join(", ")}`);
    const keep = new Set([`Metadata/plate_${want}.gcode`, `Metadata/plate_${want}.gcode.md5`, "Metadata/slice_info.config", "Metadata/project_settings.config"]);
    let total = 0;
    files = unzipSync(bytes, {
      filter: (f) => {
        if (!keep.has(f.name)) return false;
        total += f.originalSize;
        if (total > MAX_SLICED_BYTES * 2) throw new SlicedFileError("archive expands to more than 2 GB");
        return true;
      },
    });
    const gcodePath = `Metadata/plate_${want}.gcode`;
    const gcode = files[gcodePath]!;
    if (!gcode.byteLength) throw new SlicedFileError(`${gcodePath} is empty`);
    const text = (p: string) => (files[p] ? new TextDecoder().decode(files[p]) : undefined);
    const info = plateInfo(text("Metadata/slice_info.config") ?? "", want);
    let projectFilaments = 0;
    try {
      const ps = JSON.parse(text("Metadata/project_settings.config") ?? "{}") as Record<string, unknown>;
      const colours = ps.filament_colour ?? ps.filament_type;
      if (Array.isArray(colours)) projectFilaments = colours.length;
    } catch { /* not JSON: fall back below */ }
    if (!projectFilaments) projectFilaments = Math.max(1, ...(info?.filaments.map((f) => f.id) ?? [1]));
    const num = (v?: string) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));
    const declared = text(`Metadata/plate_${want}.gcode.md5`)?.trim().toLowerCase();
    const gcodeMd5 = createHash("md5").update(gcode).digest("hex");
    if (declared && declared !== gcodeMd5) throw new SlicedFileError(`plate ${want} G-code doesn't match the MD5 the slicer recorded (${declared}); the file is damaged or was altered`);
    return {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
      plates,
      projectFilaments,
      plate: {
        plate: want, gcodePath, gcodeBytes: gcode.byteLength, gcodeMd5, declaredMd5: declared,
        printerModelId: info?.meta.printer_model_id, nozzleDiameters: info?.meta.nozzle_diameters,
        predictionSeconds: num(info?.meta.prediction), weightGrams: num(info?.meta.weight),
        filaments: info?.filaments ?? [],
      },
    };
  } catch (e) {
    if (e instanceof SlicedFileError) throw e;
    throw new SlicedFileError(`not a readable 3MF: ${(e as Error).message}`);
  }
}
