import type { Mesh } from "../core/mesh";

/** The part of the occt-import-js API we use. */
export interface Occt {
  ReadStepFile(
    content: Uint8Array,
    params: { linearUnit: string; linearDeflectionType: string; linearDeflection: number; angularDeflection: number } | null,
  ): {
    success: boolean;
    meshes: { name: string; attributes: { position: { array: number[] } }; index: { array: number[] } }[];
  };
}

/** Tessellates a STEP file with OpenCascade. Same code in the browser worker and in Node tests. */
export function meshStep(occt: Occt, step: Uint8Array): Mesh[] {
  const result = occt.ReadStepFile(step, {
    linearUnit: "millimeter",
    linearDeflectionType: "bounding_box_ratio",
    linearDeflection: 0.001,
    angularDeflection: 0.5,
  });
  if (!result.success) throw new Error("OpenCascade could not read the STEP file");
  return result.meshes.map((m, i) => ({
    name: m.name || `solid ${i + 1}`,
    positions: Float32Array.from(m.attributes.position.array),
    indices: Uint32Array.from(m.index.array),
  }));
}
