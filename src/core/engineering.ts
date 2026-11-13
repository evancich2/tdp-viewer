import { z } from "zod";
import type { Manifest } from "./schema";

// The canonical engineering model (`tdp-engineering/0.1`): the minimum identity, requirement,
// characteristic, artifact, geometry-link and relationship data a downstream workflow needs to
// refer to, carried as an ordinary signed file of a `tdp-manifest/0.2` package. It is part of the
// immutable baseline. Everything that happens afterwards (approvals, builds, inspections) lives in
// separate signed records (records.ts) that point back at this baseline by digest.
//
// Deliberately not a PLM ontology. Extension points: new `system` values for sources, new artifact
// classes, new characteristic types and decision rules, new relationship types. Each needs a schema
// version bump (`tdp-engineering/0.2`), never a silent reinterpretation of 0.1 content.

const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "identifier");
const revision = z.string().min(1).max(16).regex(/^[A-Za-z0-9.-]+$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "lowercase hex SHA-256");
const isoTime = z.string().datetime({ offset: true });
const text = (max: number) => z.string().min(1).max(max);

/** An item (a part definition) at one revision. Identity of the design, not of any physical unit. */
export const ItemRef = z.object({ itemId: id, revision }).strict();
export type ItemRef = z.infer<typeof ItemRef>;
export const itemKey = (r: ItemRef) => `${r.itemId}@${r.revision}`;

/** Where a definition came from, and what that system declared. Declared, not verified: see records `source-release`. */
export const SourceSystem = z.enum(["onshape", "windchill", "lab-fixture"]);
export type SourceSystem = z.infer<typeof SourceSystem>;
export const SourceReference = z
  .object({
    id,
    system: SourceSystem,
    /** System-specific identifiers, e.g. Onshape documentId / versionId / elementId, or a Windchill number and iteration. */
    reference: z.record(z.string().regex(/^[a-z][a-zA-Z0-9]{0,31}$/), text(200)).refine((r) => Object.keys(r).length <= 12, "at most 12 reference fields"),
    declaredRevision: revision,
    declaredReleaseState: text(64),
    /** How the reference got here. Nothing in this increment pulls from a live system. */
    capture: z.enum(["manual-entry", "fixture"]),
    capturedAt: isoTime,
  })
  .strict();
export type SourceReference = z.infer<typeof SourceReference>;

export const Item = z
  .object({
    itemId: id,
    revision,
    /** Must match a BOM entry of the manifest. */
    partNumber: z.string().min(1).max(64),
    name: text(200),
    source: id.optional(),
    /** Design envelope X × Y × Z in millimetres, as declared by the design. Used for the build-volume check. */
    envelopeMm: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]).optional(),
    material: text(100).optional(),
  })
  .strict();
export type Item = z.infer<typeof Item>;

/** One use of a child item in a parent assembly. Distinct from the item's own identity: the same item can occur many times. */
export const Occurrence = z
  .object({ occurrenceId: id, parent: ItemRef, child: ItemRef, quantity: z.number().positive(), findNumber: text(16).optional() })
  .strict();
export type Occurrence = z.infer<typeof Occurrence>;

export const Requirement = z
  .object({
    id,
    version: z.number().int().positive(),
    title: text(200),
    text: text(4000),
    appliesTo: ItemRef,
    verification: z.enum(["inspection", "analysis", "test", "demonstration", "process-evidence"]),
    characteristics: z.array(id).max(200),
  })
  .strict();
export type Requirement = z.infer<typeof Requirement>;

export const Unit = z.enum(["mm", "um", "in", "g", "kg", "deg"]);
export type Unit = z.infer<typeof Unit>;
export const DecisionRule = z.enum(["guard-banded", "simple-acceptance"]);
export type DecisionRule = z.infer<typeof DecisionRule>;

/** A measurable characteristic with absolute limits. Values here must come from the design: never invented. */
export const Characteristic = z
  .object({
    id,
    requirement: id,
    item: ItemRef,
    name: text(200),
    unit: Unit,
    nominal: z.number(),
    lower: z.number(),
    upper: z.number(),
    decisionRule: DecisionRule,
    /** For simple acceptance: smallest allowed ratio of tolerance width to 2U (test uncertainty ratio). Default 4. */
    minTur: z.number().positive().optional(),
    geometry: z.array(id).max(20).optional(),
  })
  .strict()
  .refine((c) => c.lower <= c.nominal && c.nominal <= c.upper, "limits must bracket the nominal");
export type Characteristic = z.infer<typeof Characteristic>;

export const ArtifactClass = z.enum(["cad-model", "drawing", "bom", "specification", "process-input", "other"]);
export const Artifact = z
  .object({
    id,
    path: z.string().min(1).max(255),
    sha256,
    class: ArtifactClass,
    item: ItemRef.optional(),
    /** False for derived files (a 3MF, a neutral export): they inform the process but don't define the part. */
    authoritative: z.boolean(),
    source: id.optional(),
  })
  .strict();
export type Artifact = z.infer<typeof Artifact>;

/**
 * How a characteristic points at geometry. STEP solid indices and entity names are positions in one
 * file, not engineering feature identity: they are only ever valid for the exact artifact bytes
 * (`this-artifact-only`). Only a source system's persistent id may claim to survive a revision.
 */
export const GeometryMethod = z.enum(["step-solid-index", "step-entity-name", "pmi-semantic-id", "source-persistent-id"]);
export const GeometryLink = z
  .object({
    id,
    artifact: id,
    method: GeometryMethod,
    selector: text(200),
    stability: z.enum(["this-artifact-only", "revision-stable"]),
    /** Digest of the artifact the selector was taken from. A mismatch makes the link stale. */
    artifactSha256: sha256,
    item: ItemRef,
  })
  .strict();
export type GeometryLink = z.infer<typeof GeometryLink>;

export const RelationshipType = z.enum(["satisfies", "verifies", "realizes", "describes", "derived-from", "supersedes"]);
/** Endpoints are ids of model entities; items are named `itemId@revision`. */
const endpoint = z.string().min(1).max(81).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*(@[A-Za-z0-9.-]+)?$/, "entity id or itemId@revision");
export const Relationship = z.object({ type: RelationshipType, from: endpoint, to: endpoint }).strict();

export const Effectivity = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  /** Inclusive range of serials with a common prefix and zero-padded number, e.g. SN-0001 to SN-0050. */
  z.object({ kind: z.literal("serial"), from: id, to: id }).strict(),
  z.object({ kind: z.literal("lot"), lots: z.array(id).min(1).max(100) }).strict(),
]);
export type Effectivity = z.infer<typeof Effectivity>;

export const EngineeringModel = z
  .object({
    schema: z.literal("tdp-engineering/0.1"),
    /** True for demonstration data. The viewer labels synthetic content wherever it is shown. */
    synthetic: z.boolean(),
    label: text(500),
    baseline: z
      .object({
        id,
        packageId: z.string().uuid(),
        item: ItemRef,
        /** Applies to which physical units. Separate from revision (what) and release (whether). */
        effectivity: Effectivity,
        supersedes: z.object({ packageId: z.string().uuid(), manifestSha256: sha256, baselineId: id }).strict().optional(),
      })
      .strict(),
    sources: z.array(SourceReference).max(50),
    items: z.array(Item).min(1).max(1000),
    occurrences: z.array(Occurrence).max(10_000),
    requirements: z.array(Requirement).max(1000),
    characteristics: z.array(Characteristic).max(5000),
    artifacts: z.array(Artifact).max(10_000),
    geometryLinks: z.array(GeometryLink).max(10_000),
    relationships: z.array(Relationship).max(20_000),
    provenance: z.object({ generatedBy: text(200), generatedAt: isoTime, note: text(1000).optional() }).strict(),
  })
  .strict();
export type EngineeringModel = z.infer<typeof EngineeringModel>;

export interface EngineeringIssue {
  /** `error` rejects the package; `review` holds dependent workflow steps until someone reviews it. */
  severity: "error" | "review";
  message: string;
}

export type GeometryStatus = "valid" | "stale" | "unresolved";

/** A link is valid only against the exact artifact bytes it was taken from. */
export function geometryStatus(model: EngineeringModel, link: GeometryLink): GeometryStatus {
  const artifact = model.artifacts.find((a) => a.id === link.artifact);
  if (!artifact) return "unresolved";
  return artifact.sha256 === link.artifactSha256 ? "valid" : "stale";
}

/** Characteristics whose geometry links aren't valid in this baseline. Planning is held until they're reviewed. */
export function characteristicsNeedingGeometryReview(model: EngineeringModel): { id: string; links: { id: string; status: GeometryStatus }[] }[] {
  return model.characteristics.flatMap((c) => {
    const links = (c.geometry ?? []).map((lid) => {
      const link = model.geometryLinks.find((g) => g.id === lid);
      return { id: lid, status: link ? geometryStatus(model, link) : ("unresolved" as const) };
    });
    const bad = links.filter((l) => l.status !== "valid");
    return bad.length ? [{ id: c.id, links: bad }] : [];
  });
}

/**
 * Cross-checks the model against the signed manifest it travels in. Errors mean the baseline is
 * internally inconsistent and the package is rejected; review issues hold dependent steps.
 */
export function validateEngineering(model: EngineeringModel, manifest: Manifest): EngineeringIssue[] {
  const issues: EngineeringIssue[] = [];
  const error = (message: string) => issues.push({ severity: "error", message });
  const review = (message: string) => issues.push({ severity: "review", message });
  const pkg = manifest.package;

  if (model.baseline.packageId !== pkg.id) error(`baseline names package ${model.baseline.packageId}, but this package is ${pkg.id}`);
  const root = model.baseline.item;
  if (root.itemId !== pkg.partNumber || root.revision !== pkg.revision)
    error(`baseline item ${itemKey(root)} is not the package's ${pkg.partNumber}@${pkg.revision}`);

  const unique = (what: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const i of ids) {
      if (seen.has(i)) error(`duplicate ${what} id ${i}`);
      seen.add(i);
    }
    return seen;
  };
  const sources = unique("source", model.sources.map((s) => s.id));
  const items = new Set(model.items.map(itemKey));
  if (items.size !== model.items.length) error("duplicate item revision");
  unique("occurrence", model.occurrences.map((o) => o.occurrenceId));
  const reqs = unique("requirement", model.requirements.map((r) => r.id));
  const chars = unique("characteristic", model.characteristics.map((c) => c.id));
  const artifacts = unique("artifact", model.artifacts.map((a) => a.id));
  const links = unique("geometry link", model.geometryLinks.map((g) => g.id));
  const needItem = (r: ItemRef, where: string) => !items.has(itemKey(r)) && error(`${where} refers to unknown item ${itemKey(r)}`);

  needItem(root, "baseline");
  for (const it of model.items) {
    const bom = manifest.bom.find((b) => b.partNumber === it.partNumber);
    if (!bom) error(`item ${itemKey(it)} has no BOM entry for part number ${it.partNumber}`);
    else if (bom.revision !== it.revision) error(`item ${itemKey(it)} is revision ${bom.revision} in the BOM`);
    if (it.source && !sources.has(it.source)) error(`item ${itemKey(it)} names unknown source ${it.source}`);
    const src = model.sources.find((s) => s.id === it.source);
    if (src && src.declaredRevision !== it.revision) error(`source ${src.id} declares revision ${src.declaredRevision}, item is ${it.revision}`);
  }
  for (const o of model.occurrences) {
    needItem(o.parent, `occurrence ${o.occurrenceId}`);
    needItem(o.child, `occurrence ${o.occurrenceId}`);
  }
  for (const r of model.requirements) {
    needItem(r.appliesTo, `requirement ${r.id}`);
    for (const c of r.characteristics) if (!chars.has(c)) error(`requirement ${r.id} lists unknown characteristic ${c}`);
  }
  for (const c of model.characteristics) {
    needItem(c.item, `characteristic ${c.id}`);
    const req = model.requirements.find((r) => r.id === c.requirement);
    if (!req) error(`characteristic ${c.id} names unknown requirement ${c.requirement}`);
    else if (!req.characteristics.includes(c.id)) error(`characteristic ${c.id} is not listed by requirement ${req.id}`);
    for (const g of c.geometry ?? []) if (!links.has(g)) error(`characteristic ${c.id} names unknown geometry link ${g}`);
  }
  for (const a of model.artifacts) {
    const f = manifest.files.find((x) => x.path === a.path);
    if (!f) error(`artifact ${a.id}: ${a.path} is not in the manifest`);
    else if (f.sha256 !== a.sha256) error(`artifact ${a.id}: digest differs from the manifest's for ${a.path}`);
    if (a.item) needItem(a.item, `artifact ${a.id}`);
    if (a.source && !sources.has(a.source)) error(`artifact ${a.id} names unknown source ${a.source}`);
  }
  for (const g of model.geometryLinks) {
    if (!artifacts.has(g.artifact)) error(`geometry link ${g.id} names unknown artifact ${g.artifact}`);
    needItem(g.item, `geometry link ${g.id}`);
    if ((g.method === "step-solid-index" || g.method === "step-entity-name") && g.stability !== "this-artifact-only")
      error(`geometry link ${g.id}: a ${g.method} identifies a position in one file, not a feature; it can't be revision-stable`);
    const status = geometryStatus(model, g);
    if (status !== "valid") review(`geometry link ${g.id} is ${status}: it was taken from different artifact bytes and needs review`);
  }
  const known = new Set([...sources, ...items, ...reqs, ...chars, ...artifacts, ...links, model.baseline.id, ...(model.baseline.supersedes ? [model.baseline.supersedes.baselineId] : [])]);
  for (const rel of model.relationships)
    for (const end of [rel.from, rel.to]) if (!known.has(end)) error(`${rel.type} relationship refers to unknown ${end}`);
  if (model.baseline.effectivity.kind === "serial" && !serialComparable(model.baseline.effectivity.from, model.baseline.effectivity.to))
    error("serial effectivity bounds must share a prefix and digit count");
  return issues;
}

const SERIAL = /^(.*?)(\d+)$/;
function serialComparable(a: string, b: string): boolean {
  const [ma, mb] = [SERIAL.exec(a), SERIAL.exec(b)];
  return !!ma && !!mb && ma[1] === mb[1] && ma[2]!.length === mb[2]!.length;
}

/** Whether a physical unit (serial or lot) falls under the baseline's effectivity. */
export function unitInEffectivity(eff: Effectivity, unit: { serial?: string; lot?: string }): boolean {
  if (eff.kind === "none") return true;
  if (eff.kind === "lot") return !!unit.lot && eff.lots.includes(unit.lot);
  if (!unit.serial || !serialComparable(eff.from, unit.serial)) return false;
  return eff.from <= unit.serial && unit.serial <= eff.to;
}
