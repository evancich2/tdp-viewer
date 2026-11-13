import { sha256Hex } from "./bytes";
import { meshStats, weld, type Mesh, type MeshStats } from "./mesh";
import { PRINTERS, checkFit, type FitResult, type PrinterProfile } from "./printers";
import { AccessDenied, type PackageSession } from "./session";
import { write3mf } from "./threemf";

/** Turns STEP bytes into triangle meshes. The browser runs this in a throwaway worker. */
export type StepMesher = (step: Uint8Array) => Promise<Mesh[]>;

export interface PrintExport {
  fileName: string;
  bytes: Uint8Array;
  sha256: string;
  meshes: { name: string; stats: MeshStats; fit: FitResult }[];
  printer: PrinterProfile;
  /** True when every solid fits the printer's build volume in some orientation. */
  fits: boolean;
}

/**
 * Builds a 3MF for a slicer such as Bambu Studio from a verified STEP model.
 * The STEP bytes come through PackageSession.openFile, so they're re-verified and the access is
 * logged; the export itself is logged with the output's digest so a printed part traces back to
 * the exact signed package it came from.
 */
export async function exportForPrint(
  session: PackageSession,
  path: string,
  mesher: StepMesher,
  { now = new Date(), printer = PRINTERS[0]! }: { now?: Date; printer?: PrinterProfile } = {},
): Promise<PrintExport> {
  const { print } = session.policy;
  const deny = async (why: string): Promise<never> => {
    await session.audit.append("deny", path, `print export: ${why}`);
    throw new AccessDenied(`${path}: ${why}`);
  };
  if (!print.allowExport) return deny("print export is disabled by policy");
  const meta = session.manifest?.files.find((f) => f.path === path);
  if (meta && (meta.role !== "model" || meta.mediaType !== "model/step")) return deny("not a STEP model");

  const { file, bytes } = await session.openFile(path, "print export");
  let meshes: Mesh[];
  try {
    meshes = (await mesher(bytes)).map((m) => weld(m));
  } catch (e) {
    return deny(`could not tessellate: ${(e as Error).message}`);
  }
  if (meshes.length === 0) return deny("model has no solid geometry");
  // Each solid becomes its own object on the plate, so each must fit on its own.
  const stats = meshes.map((m) => {
    const st = meshStats(m);
    const size = [0, 1, 2].map((k) => st.max[k]! - st.min[k]!) as [number, number, number];
    return { name: m.name, stats: st, fit: checkFit(size, printer) };
  });
  const fits = stats.every((m) => m.fit.fits);
  const triangles = stats.reduce((sum, m) => sum + m.stats.triangles, 0);
  if (triangles > print.maxTriangles) return deny(`${triangles} triangles exceeds the policy limit`);
  const leaky = stats.filter((m) => !m.stats.watertight);
  if (print.requireWatertight && leaky.length) return deny(`not watertight: ${leaky.map((m) => m.name).join(", ")}`);

  const pkg = session.manifest!.package;
  const sized = printer.buildVolume.every(Number.isFinite);
  const out = write3mf(meshes, {
    title: pkg.title,
    partNumber: file.partNumber ?? pkg.partNumber,
    revision: file.revision ?? pkg.revision,
    packageId: pkg.id,
    manifestSha256: session.result.manifestSha256!,
    sourcePath: file.path,
    sourceSha256: file.sha256,
    exportedAt: now.toISOString(),
    targetPrinter: sized ? printer.name : undefined,
    targetPrinterFirmware: sized ? printer.firmware : undefined,
  });
  const sha256 = await sha256Hex(out);
  const base = file.path.split("/").pop()!.replace(/\.[^.]+$/, "");
  const fileName = `${base}.3mf`;
  const target = printer.firmware ? `${printer.name} (firmware ${printer.firmware})` : printer.name;
  const fitNote = fits ? `fits ${target}` : `TOO LARGE for ${target}`;
  await session.audit.append("export", path, `3MF for printing, ${triangles} triangles, ${fitNote}, sha256 ${sha256}`);
  return { fileName, bytes: out, sha256, meshes: stats, printer, fits };
}
