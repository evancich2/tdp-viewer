import { z } from "zod";
import { Unit, type EngineeringModel, type ItemRef } from "./engineering";
import { convert } from "./inspection";
import { checkFit } from "./printers";

// Process suitability: does a declared resource (printer, material, profile, orientation) have
// evidence of capability for the item's characteristics? Build-volume fit is one check among
// several and never establishes capability by itself. Missing evidence is a gap for engineering
// review, not a pass. The engine recomputes this from the record's inputs, so the conclusion in a
// signed record can't disagree with its own evidence.

const isoTime = z.string().datetime({ offset: true });
const evidenceId = z.string().min(1).max(64);

export const SuitabilityInput = z
  .object({
    resource: z
      .object({
        id: z.string().min(1).max(64),
        model: z.string().min(1).max(100),
        serial: z.string().min(1).max(64).optional(),
        /** Null when it hasn't been read from the machine. */
        firmware: z.string().min(1).max(64).nullable(),
        buildVolumeMm: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]),
      })
      .strict(),
    material: z.object({ name: z.string().min(1).max(100), lot: z.string().min(1).max(64).optional() }).strict(),
    profile: z.object({ name: z.string().min(1).max(200), sha256: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict(),
    orientation: z.string().min(1).max(200),
    /** The bounded geometry and process scope this review covers. */
    scope: z.string().min(1).max(1000),
    /** Demonstrated dimensional capability: ± deviation at the stated coverage, from a capability study. */
    capabilities: z
      .array(
        z
          .object({
            /** A characteristic id, or "*" for a general capability claim covering all length characteristics. */
            appliesTo: z.string().min(1).max(64),
            deviation: z.number().nonnegative(),
            unit: Unit,
            basis: z.string().min(1).max(500),
            evidence: evidenceId,
            validUntil: isoTime,
          })
          .strict(),
      )
      .max(200),
    calibration: z.array(z.object({ what: z.string().min(1).max(200), evidence: evidenceId, validUntil: isoTime }).strict()).max(50),
    /** Gaps the reviewer already knows about. */
    declaredGaps: z.array(z.string().min(1).max(500)).max(50),
  })
  .strict();
export type SuitabilityInput = z.infer<typeof SuitabilityInput>;

export type SuitabilityOutcome = "suitable" | "review-required" | "not-suitable";

export interface SuitabilityCheck {
  id: string;
  result: "pass" | "fail" | "gap";
  message: string;
}

export function evaluateSuitability(model: EngineeringModel, item: ItemRef, input: SuitabilityInput, at: string, evidenceIds: ReadonlySet<string>): { outcome: SuitabilityOutcome; checks: SuitabilityCheck[] } {
  const checks: SuitabilityCheck[] = [];
  const add = (id: string, result: SuitabilityCheck["result"], message: string) => checks.push({ id, result, message });
  const it = model.items.find((i) => i.itemId === item.itemId && i.revision === item.revision);
  const t = Date.parse(at);

  if (!it?.envelopeMm) add("build-volume", "gap", "the design declares no envelope, so build-volume fit can't be checked");
  else {
    const fit = checkFit(it.envelopeMm, { id: input.resource.id, name: input.resource.model, buildVolume: input.resource.buildVolumeMm });
    add("build-volume", fit.fits ? "pass" : "fail", fit.fits
      ? `envelope ${it.envelopeMm.join(" × ")} mm fits ${input.resource.buildVolumeMm.join(" × ")} mm in some orientation (fit alone doesn't establish capability)`
      : `envelope ${it.envelopeMm.join(" × ")} mm does not fit ${input.resource.buildVolumeMm.join(" × ")} mm`);
  }
  if (!it?.material) add("material", "gap", "the design declares no material");
  else add("material", it.material === input.material.name ? "pass" : "fail", it.material === input.material.name ? `material ${it.material} matches the design` : `design requires ${it.material}, process uses ${input.material.name}`);
  add("firmware", input.resource.firmware ? "pass" : "gap", input.resource.firmware ? `firmware ${input.resource.firmware} recorded` : "printer firmware not recorded");

  const cal = input.calibration.filter((c) => Date.parse(c.validUntil) >= t && evidenceIds.has(c.evidence));
  add("calibration", cal.length ? "pass" : "gap", cal.length ? `calibration current: ${cal.map((c) => c.what).join(", ")}` : "no current calibration evidence attached");

  for (const c of model.characteristics.filter((x) => x.item.itemId === item.itemId && x.item.revision === item.revision)) {
    const half = Math.min(c.nominal - c.lower, c.upper - c.nominal);
    const cap = input.capabilities.find((k) => k.appliesTo === c.id) ?? input.capabilities.find((k) => k.appliesTo === "*");
    const id = `capability:${c.id}`;
    if (!cap) { add(id, "gap", `${c.id}: no capability evidence for ±${half} ${c.unit}`); continue; }
    const dev = convert(cap.deviation, cap.unit, c.unit);
    if (dev === null) { add(id, "gap", `${c.id}: capability stated in ${cap.unit}, characteristic in ${c.unit}`); continue; }
    if (!evidenceIds.has(cap.evidence)) { add(id, "gap", `${c.id}: capability evidence ${cap.evidence} not attached`); continue; }
    if (Date.parse(cap.validUntil) < t) { add(id, "gap", `${c.id}: capability evidence expired ${cap.validUntil}`); continue; }
    add(id, dev <= half ? "pass" : "fail", dev <= half
      ? `${c.id}: demonstrated ±${dev} ${c.unit} within ±${half} ${c.unit}`
      : `${c.id}: demonstrated ±${dev} ${c.unit} exceeds ±${half} ${c.unit}`);
  }
  for (const g of input.declaredGaps) add("declared", "gap", g);
  const outcome: SuitabilityOutcome = checks.some((c) => c.result === "fail") ? "not-suitable" : checks.some((c) => c.result === "gap") ? "review-required" : "suitable";
  return { outcome, checks };
}
