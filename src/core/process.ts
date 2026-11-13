import { z } from "zod";
import { sha256Hex, utf8 } from "./bytes";
import { WorkflowRole } from "./authority";

// A process definition (`tdp-process/0.1`) is configuration, not code: states, transitions, who may
// take each one, what evidence and authorization it needs, and where each outcome leads. The engine
// (records.ts) knows only the record *kinds* below and their typed payloads; any process built from
// them runs without engine changes. Definitions are pinned by digest in the authority configuration.

const id = z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/, "lowercase-with-dashes id");

/** Record kinds the engine understands, and the outcomes each can have. */
export const KIND_OUTCOMES = {
  "requirements-approval": ["approved"],
  "source-release": ["verified"],
  suitability: ["suitable", "review-required", "not-suitable"],
  "suitability-review": ["accepted", "rejected"],
  plan: ["planned"],
  authorization: ["issued"],
  "queue-entry": ["queued"],
  "build-start": ["started"],
  "build-complete": ["completed", "failed"],
  inspection: ["accept", "reject", "indeterminate"],
  nonconformance: ["raised"],
  disposition: ["accept", "use-as-is", "rework", "scrap"],
  closure: ["closed"],
} as const;
export type RecordKind = keyof typeof KIND_OUTCOMES;
export const RecordKind = z.enum(Object.keys(KIND_OUTCOMES) as [RecordKind, ...RecordKind[]]);

export const Transition = z
  .object({
    id,
    kind: RecordKind,
    description: z.string().min(1).max(500),
    from: z.array(id).min(1),
    /** Next state for each outcome. An outcome not listed is not allowed by this transition. */
    outcomes: z.record(z.string(), id),
    roles: z.array(WorkflowRole).min(1),
    /** If set, only these organizations (by name) may take this step. */
    organizations: z.array(z.string().min(1).max(200)).optional(),
    requires: z
      .object({
        /** Earlier transitions that must appear in the history, with any of the listed outcomes (any outcome if omitted). */
        actions: z.array(z.object({ id, outcomes: z.array(z.string()).optional() }).strict()).default([]),
        /** Evidence tags the record must carry, each backed by a hash-verified file. */
        evidence: z.array(z.string().min(1).max(64)).default([]),
        /** An operation that a valid authorization (CIP) in the history must cover. */
        authorization: z.string().min(1).max(64).optional(),
        /** Needs revocation freshness: denied once the authority configuration is past its offline validity window. */
        freshAuthority: z.boolean().default(false),
        /** Needs a physical serial or lot. */
        unit: z.boolean().default(false),
      })
      .strict()
      .default({ actions: [], evidence: [], freshAuthority: false, unit: false }),
    /** Must be signed by a different key than the latest record of each of these transitions. */
    distinctActorFrom: z.array(id).default([]),
    /** Must come from a different organization than the latest record of each of these transitions. */
    distinctOrganizationFrom: z.array(id).default([]),
  })
  .strict();
export type Transition = z.infer<typeof Transition>;

export const ProcessDefinition = z
  .object({
    schema: z.literal("tdp-process/0.1"),
    id,
    version: z.number().int().positive(),
    title: z.string().min(1).max(200),
    label: z.string().min(1).max(500),
    synthetic: z.boolean(),
    roles: z.array(z.object({ id: WorkflowRole, description: z.string().min(1).max(300) }).strict()).min(1).max(32),
    states: z.array(id).min(2).max(64),
    initial: id,
    terminal: z.array(id).min(1),
    /** Operations an authorization (CIP) may name. */
    operations: z.array(z.string().min(1).max(64)).max(32),
    /** Whether keys with `mayDelegate` grants may issue delegation records in this process. */
    allowDelegation: z.boolean(),
    transitions: z.array(Transition).min(1).max(100),
  })
  .strict();
export type ProcessDefinition = z.infer<typeof ProcessDefinition>;

/** Internal consistency: every name used is declared, every outcome is one its kind can produce. */
export function validateProcess(p: ProcessDefinition): string[] {
  const problems: string[] = [];
  const states = new Set(p.states);
  const roles = new Set(p.roles.map((r) => r.id));
  const ids = new Set<string>();
  if (!states.has(p.initial)) problems.push(`initial state ${p.initial} is not declared`);
  for (const t of p.terminal) if (!states.has(t)) problems.push(`terminal state ${t} is not declared`);
  for (const t of p.transitions) {
    if (ids.has(t.id)) problems.push(`duplicate transition ${t.id}`);
    ids.add(t.id);
  }
  for (const t of p.transitions) {
    for (const s of t.from) if (!states.has(s)) problems.push(`${t.id}: unknown from-state ${s}`);
    const allowed: readonly string[] = KIND_OUTCOMES[t.kind];
    if (!Object.keys(t.outcomes).length) problems.push(`${t.id}: no outcomes`);
    for (const [o, s] of Object.entries(t.outcomes)) {
      if (!allowed.includes(o)) problems.push(`${t.id}: ${t.kind} can't have outcome ${o}`);
      if (!states.has(s)) problems.push(`${t.id}: outcome ${o} leads to unknown state ${s}`);
    }
    for (const r of t.roles) if (!roles.has(r)) problems.push(`${t.id}: undeclared role ${r}`);
    for (const a of t.requires.actions) if (!ids.has(a.id)) problems.push(`${t.id}: requires unknown transition ${a.id}`);
    for (const d of [...t.distinctActorFrom, ...t.distinctOrganizationFrom]) if (!ids.has(d)) problems.push(`${t.id}: independence from unknown transition ${d}`);
    if (t.requires.authorization && !p.operations.includes(t.requires.authorization)) problems.push(`${t.id}: authorization for undeclared operation ${t.requires.authorization}`);
  }
  return problems;
}

export interface LoadedProcess {
  definition: ProcessDefinition;
  /** SHA-256 of the exact file bytes; the authority configuration pins this. */
  sha256: string;
}

export async function loadProcess(json: string): Promise<LoadedProcess> {
  const definition = ProcessDefinition.parse(JSON.parse(json));
  const problems = validateProcess(definition);
  if (problems.length) throw new Error(`process ${definition.id}: ${problems.join("; ")}`);
  return { definition, sha256: await sha256Hex(utf8.encode(json)) };
}
