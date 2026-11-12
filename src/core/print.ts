import { sha256Hex } from "./bytes";
import { meshStats, weld, type Mesh, type MeshStats } from "./mesh";
import { AccessDenied, type PackageSession } from "./session";
import { write3mf } from "./threemf";

/** Turns STEP bytes into triangle meshes. The browser runs this in a throwaway worker. */
export type StepMesher = (step: Uint8Array) => Promise<Mesh[]>;

export interface PrintExport {
  fileName: string;
  bytes: Uint8Array;
  sha256: string;
  meshes: { name: string; stats: MeshStats }[];
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
  now: Date = new Date(),
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
  const stats = meshes.map((m) => ({ name: m.name, stats: meshStats(m) }));
  const triangles = stats.reduce((sum, m) => sum + m.stats.triangles, 0);
  if (triangles > print.maxTriangles) return deny(`${triangles} triangles exceeds the policy limit`);
  const leaky = stats.filter((m) => !m.stats.watertight);
  if (print.requireWatertight && leaky.length) return deny(`not watertight: ${leaky.map((m) => m.name).join(", ")}`);

  const pkg = session.manifest!.package;
  const out = write3mf(meshes, {
    title: pkg.title,
    partNumber: file.partNumber ?? pkg.partNumber,
    revision: file.revision ?? pkg.revision,
    packageId: pkg.id,
    manifestSha256: session.result.manifestSha256!,
    sourcePath: file.path,
    sourceSha256: file.sha256,
    exportedAt: now.toISOString(),
  });
  const sha256 = await sha256Hex(out);
  const base = file.path.split("/").pop()!.replace(/\.[^.]+$/, "");
  const fileName = `${base}.3mf`;
  await session.audit.append("export", path, `3MF for printing, ${triangles} triangles, sha256 ${sha256}`);
  return { fileName, bytes: out, sha256, meshes: stats };
}
