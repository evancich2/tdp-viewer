/** A triangle mesh in millimetres. `indices` holds three vertex indices per triangle. */
export interface Mesh {
  name: string;
  positions: Float32Array | number[];
  indices: Uint32Array | number[];
}

export interface MeshStats {
  vertices: number;
  triangles: number;
  min: [number, number, number];
  max: [number, number, number];
  /** True when every edge is shared by exactly two triangles, as 3D printing needs. */
  watertight: boolean;
}

/**
 * Merges vertices closer than `tolerance` and drops degenerate triangles.
 * CAD tessellators emit each face separately, so without this the mesh isn't watertight.
 */
export function weld(mesh: Mesh, tolerance = 1e-4): Mesh {
  const key = (i: number) =>
    [0, 1, 2].map((k) => Math.round(Number(mesh.positions[i * 3 + k]) / tolerance)).join(",");
  const remap: number[] = [];
  const seen = new Map<string, number>();
  const positions: number[] = [];
  for (let i = 0; i < mesh.positions.length / 3; i++) {
    const k = key(i);
    let idx = seen.get(k);
    if (idx === undefined) {
      idx = positions.length / 3;
      seen.set(k, idx);
      positions.push(Number(mesh.positions[i * 3]), Number(mesh.positions[i * 3 + 1]), Number(mesh.positions[i * 3 + 2]));
    }
    remap.push(idx);
  }
  const indices: number[] = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => remap[Number(mesh.indices[t + k])]!) as [number, number, number];
    if (a !== b && b !== c && a !== c) indices.push(a, b, c);
  }
  return { name: mesh.name, positions, indices };
}

export function meshStats(mesh: Mesh): MeshStats {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i++) {
    const v = Number(mesh.positions[i]);
    const k = i % 3;
    if (v < min[k]!) min[k] = v;
    if (v > max[k]!) max[k] = v;
  }
  // Each directed edge must appear once, with its reverse appearing once (consistent winding).
  const edges = new Map<string, number>();
  for (let t = 0; t < mesh.indices.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = Number(mesh.indices[t + k]);
      const b = Number(mesh.indices[t + ((k + 1) % 3)]);
      edges.set(`${a}>${b}`, (edges.get(`${a}>${b}`) ?? 0) + 1);
    }
  }
  let watertight = edges.size > 0;
  for (const [e, count] of edges) {
    const [a, b] = e.split(">");
    if (count !== 1 || edges.get(`${b}>${a}`) !== 1) {
      watertight = false;
      break;
    }
  }
  return { vertices: mesh.positions.length / 3, triangles: mesh.indices.length / 3, min, max, watertight };
}
