import { z } from "zod";
import type { VerifyResult } from "./verify";
import type { LedgerResult } from "./records";
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const text = (n: number) => z.string().min(1).max(n);
export const ReferenceTarget = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("baseline"),
      packageId: z.string().uuid(),
      manifestSha256: digest,
      baselineId: text(64),
    })
    .strict(),
  z
    .object({
      kind: z.literal("record"),
      packageId: z.string().uuid(),
      manifestSha256: digest,
      baselineId: text(64),
      recordId: z.string().uuid(),
      recordSha256: digest,
    })
    .strict(),
]);
export type ReferenceTarget = z.infer<typeof ReferenceTarget>;
export const PackageReference = z
  .object({
    id: text(64),
    relationship: text(64),
    purpose: text(500),
    target: ReferenceTarget,
    tags: z.array(text(64)).max(32),
    // A request is evidence to review, never an approval. Both exact versions stay retained.
    change: z
      .object({
        reason: text(1000),
        predecessor: ReferenceTarget,
        request: ReferenceTarget.refine(
          (t) => t.kind === "record",
          "standing change request must name an exact workflow record",
        ),
      })
      .strict()
      .optional(),
  })
  .strict();
export const ReferenceSet = z
  .object({
    schema: z.literal("tdp-references/0.1"),
    references: z.array(PackageReference).max(128),
  })
  .strict()
  .refine(
    (s) => new Set(s.references.map((r) => r.id)).size === s.references.length,
    "duplicate reference id",
  );
export type ReferenceSet = z.infer<typeof ReferenceSet>;
export const REFERENCE_HOLD =
  "cross-package references require policy-aware engineering review; identity matching does not authorize new work";
export interface ReferenceReview {
  id: string;
  status: "matched" | "held";
  reasons: string[];
  authorized: false;
}
const identity = (t: ReferenceTarget) =>
  `${t.packageId}:${t.manifestSha256}:${t.baselineId}`;
const packageIdentity = (p: VerifyResult) =>
  `${p.manifest?.package.id}:${p.manifestSha256}:${p.engineering?.model.baseline.id}`;

/** Local, bounded identity review. Inputs come from the ordinary package/ledger verifiers.
 * Never fetches a locator, chooses "latest", clears a hold or grants release authority. */
export function reviewReferences(
  source: VerifyResult,
  packages: readonly VerifyResult[],
  ledgers: readonly LedgerResult[] = [],
  maxDepth = 8,
): ReferenceReview[] {
  if (source.verdict !== "trusted")
    throw new Error("reference source is not trusted");
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 32)
    throw new Error("reference depth must be 1..32");
  if (packages.length > 128 || ledgers.length > 128)
    throw new Error("at most 128 local packages and ledgers");
  const pool = [source, ...packages];
  const byIdentity = new Map<string, VerifyResult[]>(),
    superseded = new Set<string>(),
    definitions = new Map<string, Set<string>>();
  const definitionKey = (p: VerifyResult) =>
    `${p.manifest!.package.partNumber}@${p.manifest!.package.revision}`;
  for (const p of pool) {
    if (!p.engineering) continue;
    const key = packageIdentity(p);
    byIdentity.set(key, [...(byIdentity.get(key) ?? []), p]);
    if (p.verdict !== "trusted") continue;
    const prior = p.engineering.model.baseline.supersedes;
    if (prior) superseded.add(identity({ ...prior, kind: "baseline" }));
    const group = definitionKey(p),
      hashes = definitions.get(group) ?? new Set<string>();
    hashes.add(
      JSON.stringify(
        p.engineering.model.artifacts
          .filter((a) => a.authoritative)
          .map((a) => `${a.id}:${a.sha256}`)
          .sort(),
      ),
    );
    definitions.set(group, hashes);
  }
  let visits = 0;
  const targetProblems = (
    target: ReferenceTarget,
    seen: Set<string>,
    depth: number,
  ): string[] => {
    if (++visits > 2048) return ["reference traversal budget exceeded"];
    const key = identity(target);
    if (seen.has(key)) return ["reference cycle"];
    if (depth > maxDepth) return ["reference traversal depth exceeded"];
    const candidates = byIdentity.get(key) ?? [];
    if (!candidates.length)
      return ["exact target baseline unavailable (no substitution)"];
    const p = candidates.find((p) => p.verdict === "trusted");
    if (!p) return ["target baseline is not trusted"];
    const problems: string[] = [];
    if (superseded.has(key)) problems.push("target baseline is superseded");
    if ((definitions.get(definitionKey(p))?.size ?? 0) > 1)
      problems.push("conflicting authoritative content for item/revision");
    if (target.kind === "record") {
      const ledger = ledgers.find(
        (l) =>
          l.verdict === "verified" &&
          l.instance?.packageId === target.packageId &&
          l.instance.manifestSha256 === target.manifestSha256 &&
          l.instance.baselineId === target.baselineId &&
          l.records.some(
            (r) =>
              r.record.recordId === target.recordId &&
              r.sha256 === target.recordSha256,
          ),
      );
      if (!ledger)
        problems.push(
          "exact record not available in a verified baseline-bound ledger",
        );
    }
    const next = new Set(seen);
    next.add(key);
    for (const r of p.references?.references ?? [])
      problems.push(...referenceProblems(r, next, depth + 1));
    return problems;
  };
  const referenceProblems = (
    r: z.infer<typeof PackageReference>,
    seen: Set<string>,
    depth: number,
  ): string[] => {
    const problems = targetProblems(r.target, seen, depth);
    if (r.tags.includes("modified") && !r.change)
      problems.push(
        "modified artifact needs a reason, exact predecessor and standing change request",
      );
    if (r.change) {
      if (
        identity(r.change.predecessor) === identity(r.target) &&
        r.change.predecessor.kind === "baseline" &&
        r.target.kind === "baseline"
      )
        problems.push("modified baseline must differ from its predecessor");
      problems.push(
        ...targetProblems(r.change.predecessor, seen, depth),
        ...targetProblems(r.change.request, seen, depth),
      );
      problems.push(
        "standing change request requires authorized recorded resolution",
      );
    }
    return [...new Set(problems)];
  };
  return (source.references?.references ?? []).map((r) => {
    const reasons = referenceProblems(r, new Set([packageIdentity(source)]), 1);
    return {
      id: r.id,
      status: reasons.length ? "held" : "matched",
      reasons,
      authorized: false,
    };
  });
}
