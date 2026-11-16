import { sha256Hex } from "./bytes";
import { parsePrintSettings, type PrintSettings } from "./printsettings";
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
  settings?: { path: string; sha256: string; value: PrintSettings };
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
  { now = new Date(), printer = PRINTERS[0]!, settingsPath }: { now?: Date; printer?: PrinterProfile; settingsPath?: string } = {},
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
  let settings: PrintExport["settings"];
  if (settingsPath) {
    try {
      const opened = await session.openFile(settingsPath, "print settings");
      if (opened.file.mediaType !== "application/json" || opened.file.role !== "other") throw new Error("settings must be a manifest-listed JSON process input with role other");
      if (session.engineering) {
        const artifact = session.engineering.model.artifacts.find((a) => a.path === settingsPath);
        if (!artifact || artifact.class !== "process-input" || artifact.authoritative) throw new Error("settings must be a non-authoritative process-input artifact");
      }
      const value = parsePrintSettings(new TextDecoder("utf-8", { fatal: true }).decode(opened.bytes));
      if (value.modelPath !== path || value.modelSha256 !== file.sha256) throw new Error("settings are bound to a different model or model digest");
      if (value.printerId !== printer.id) throw new Error("settings are bound to a different printer profile");
      settings = { path: settingsPath, sha256: opened.file.sha256, value };
    } catch (e) {
      return deny(`invalid print settings: ${(e as Error).message}`);
    }
  }
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
    printSettings: settings?.value,
    printSettingsPath: settings?.path,
    printSettingsSha256: settings?.sha256,
  });
  const sha256 = await sha256Hex(out);
  const base = file.path.split("/").pop()!.replace(/\.[^.]+$/, "");
  const fileName = `${base}.3mf`;
  const target = printer.firmware ? `${printer.name} (firmware ${printer.firmware})` : printer.name;
  const fitNote = fits ? `fits ${target}` : `TOO LARGE for ${target}`;
  await session.audit.append("export", path, `3MF for printing, ${triangles} triangles, ${fitNote}, sha256 ${sha256}${settings ? `, settings ${settings.path} sha256 ${settings.sha256}` : ""}`);
  return { fileName, bytes: out, sha256, meshes: stats, printer, fits, settings };
}

/**
 * Hands back a packaged 3MF process input's exact bytes for saving outside the viewer. Leaving the
 * viewer is an export, so the same policy switch as exportForPrint governs it.
 */
export async function exportProcessInput(session: PackageSession, path: string): Promise<{ fileName: string; bytes: Uint8Array; sha256: string }> {
  const deny = async (why: string): Promise<never> => {
    await session.audit.append("deny", path, `process input export: ${why}`);
    throw new AccessDenied(`${path}: ${why}`);
  };
  if (!session.policy.print.allowExport) return deny("export is disabled by policy");
  const meta = session.manifest?.files.find((f) => f.path === path);
  if (meta && (meta.role !== "other" || meta.mediaType !== "model/3mf")) return deny("not a 3MF process input");
  const { file, bytes } = await session.openFile(path, "export process input");
  await session.audit.append("export", path, `opaque 3MF process input sha256 ${file.sha256}`);
  return { fileName: file.path.split("/").pop()!, bytes, sha256: file.sha256 };
}
