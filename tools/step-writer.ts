// Writes STEP AP242 files containing planar B-rep solids made by extruding 2D polygons.
// Enough real geometry for the sample packages without pulling in a CAD kernel.
import { utf8 } from "../src/core/bytes";

export interface Prism {
  /** Counter-clockwise outline in the XY plane, in millimetres. */
  outline: [number, number][];
  z0: number;
  height: number;
}

type Vec = [number, number, number];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (v: Vec) => Math.hypot(...v);
const unit = (v: Vec): Vec => v.map((c) => c / len(v)) as Vec;
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const num = (n: number) => (Number.isInteger(n) ? `${n}.` : String(n));
const vec = (v: Vec) => `(${v.map(num).join(",")})`;

class StepWriter {
  private lines: string[] = [];
  add(entity: string): string {
    const id = `#${this.lines.length + 1}`;
    this.lines.push(`${id}=${entity};`);
    return id;
  }
  get data() {
    return this.lines.join("\n");
  }
}

function writeSolid(w: StepWriter, prism: Prism, name: string): string {
  const { outline, z0, height } = prism;
  const n = outline.length;
  const points: Vec[] = [
    ...outline.map(([x, y]): Vec => [x, y, z0]),
    ...outline.map(([x, y]): Vec => [x, y, z0 + height]),
  ];
  const vertices = points.map((p) => w.add(`VERTEX_POINT('',${w.add(`CARTESIAN_POINT('',${vec(p)})`)})`));

  // Faces as vertex-index loops, counter-clockwise seen from outside.
  const bottom = Array.from({ length: n }, (_, i) => n - 1 - i);
  const top = Array.from({ length: n }, (_, i) => n + i);
  const sides = Array.from({ length: n }, (_, i) => [i, (i + 1) % n, n + ((i + 1) % n), n + i]);

  const edges = new Map<string, string>();
  const orientedEdge = (a: number, b: number) => {
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    let edge = edges.get(key);
    const [s, e] = a < b ? [a, b] : [b, a];
    if (!edge) {
      const d = sub(points[e]!, points[s]!);
      const dir = w.add(`DIRECTION('',${vec(unit(d))})`);
      const line = w.add(`LINE('',${w.add(`CARTESIAN_POINT('',${vec(points[s]!)})`)},${w.add(`VECTOR('',${dir},${num(len(d))})`)})`);
      edge = w.add(`EDGE_CURVE('',${vertices[s]},${vertices[e]},${line},.T.)`);
      edges.set(key, edge);
    }
    return w.add(`ORIENTED_EDGE('',*,*,${edge},${a < b ? ".T." : ".F."})`);
  };

  const faces = [bottom, top, ...sides].map((loop) => {
    const p0 = points[loop[0]!]!;
    const u = sub(points[loop[1]!]!, p0);
    const v = sub(points[loop[loop.length - 1]!]!, p0);
    const normal = unit(cross(u, v));
    const oriented = loop.map((a, i) => orientedEdge(a, loop[(i + 1) % loop.length]!));
    const edgeLoop = w.add(`EDGE_LOOP('',(${oriented.join(",")}))`);
    const bound = w.add(`FACE_OUTER_BOUND('',${edgeLoop},.T.)`);
    const placement = w.add(
      `AXIS2_PLACEMENT_3D('',${w.add(`CARTESIAN_POINT('',${vec(p0)})`)},${w.add(`DIRECTION('',${vec(normal)})`)},${w.add(`DIRECTION('',${vec(unit(u))})`)})`,
    );
    return w.add(`ADVANCED_FACE('',(${bound}),${w.add(`PLANE('',${placement})`)},.T.)`);
  });
  const shell = w.add(`CLOSED_SHELL('',(${faces.join(",")}))`);
  return w.add(`MANIFOLD_SOLID_BREP('${name}',${shell})`);
}

const esc = (s: string) => s.replace(/'/g, "''");

export function writeStep(partNumber: string, name: string, prisms: Prism[]): Uint8Array {
  const w = new StepWriter();
  const appContext = w.add("APPLICATION_CONTEXT('managed model based 3d engineering')");
  w.add(`APPLICATION_PROTOCOL_DEFINITION('international standard','ap242_managed_model_based_3d_engineering',2014,${appContext})`);
  const product = w.add(`PRODUCT('${esc(partNumber)}','${esc(name)}','',(${w.add(`PRODUCT_CONTEXT('',${appContext},'mechanical')`)}))`);
  const formation = w.add(`PRODUCT_DEFINITION_FORMATION('','',${product})`);
  const definition = w.add(`PRODUCT_DEFINITION('design','',${formation},${w.add(`PRODUCT_DEFINITION_CONTEXT('part definition',${appContext},'design')`)})`);
  const shapeDef = w.add(`PRODUCT_DEFINITION_SHAPE('','',${definition})`);

  const mm = w.add("( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )");
  const rad = w.add("( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )");
  const sr = w.add("( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() )");
  const tol = w.add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),${mm},'distance_accuracy_value','')`);
  const context = w.add(
    `( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${tol})) GLOBAL_UNIT_ASSIGNED_CONTEXT((${mm},${rad},${sr})) REPRESENTATION_CONTEXT('','') )`,
  );

  const solids = prisms.map((p, i) => writeSolid(w, p, `${partNumber}-${i + 1}`));
  const origin = w.add(
    `AXIS2_PLACEMENT_3D('',${w.add("CARTESIAN_POINT('',(0.,0.,0.))")},${w.add("DIRECTION('',(0.,0.,1.))")},${w.add("DIRECTION('',(1.,0.,0.))")})`,
  );
  const rep = w.add(`ADVANCED_BREP_SHAPE_REPRESENTATION('',(${[origin, ...solids].join(",")}),${context})`);
  w.add(`SHAPE_DEFINITION_REPRESENTATION(${shapeDef},${rep})`);

  return utf8.encode(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Synthetic sample part'),'2;1');
FILE_NAME('${esc(partNumber)}.stp','2026-01-01T00:00:00',('tdp-viewer'),(''),'','','');
FILE_SCHEMA(('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }'));
ENDSEC;
DATA;
${w.data}
ENDSEC;
END-ISO-10303-21;
`);
}
