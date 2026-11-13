import { z } from "zod";
import { Unit, type Characteristic } from "./engineering";

// Deterministic acceptance logic for measured characteristics. Decision rules ("core/decision-rules/0.1"):
//
//   guard-banded (ISO 14253-1 style, conformance must be proven):
//     accept       if lower + U ≤ x ≤ upper − U
//     reject       if x < lower − U  or  x > upper + U
//     indeterminate otherwise (the measurement can't tell)
//   simple-acceptance (ILAC G8 style, shared risk, only with a small enough uncertainty):
//     indeterminate if TUR = (upper − lower) / 2U is below minTur (default 4)
//     accept        if lower ≤ x ≤ upper, else reject
//
// U is the expanded uncertainty (coverage factor k as stated). Values are converted to the
// characteristic's unit and rounded to 1e-9 of that unit before comparison, so float noise from
// conversion can't flip a result. Anything missing or incompatible (unit family, instrument,
// calibration, uncertainty) makes the characteristic indeterminate: never an automatic pass.
// The measurement outcome is separate from engineering disposition, which an authorized person decides.

export const DECISION_RULES_ID = "core/decision-rules/0.1";

const evidenceId = z.string().min(1).max(64);
const isoTime = z.string().datetime({ offset: true });

export const Measurement = z
  .object({
    characteristic: z.string().min(1).max(64),
    value: z.number(),
    unit: Unit,
    method: z.string().min(1).max(200),
    instrument: z
      .object({
        id: z.string().min(1).max(64),
        description: z.string().min(1).max(200),
        /** Evidence id (in the record's evidence list) of the calibration certificate. */
        calibrationEvidence: evidenceId.optional(),
        calibrationValidUntil: isoTime.optional(),
      })
      .strict()
      .optional(),
    uncertainty: z
      .object({ expanded: z.number().nonnegative(), k: z.number().positive(), unit: Unit, basis: z.string().min(1).max(500) })
      .strict()
      .optional(),
    measuredAt: isoTime,
  })
  .strict();
export type Measurement = z.infer<typeof Measurement>;

export type MeasurementResult = "accept" | "reject" | "indeterminate";

const FAMILY: Record<z.infer<typeof Unit>, { family: string; toBase: number }> = {
  mm: { family: "length", toBase: 1 },
  um: { family: "length", toBase: 0.001 },
  in: { family: "length", toBase: 25.4 },
  g: { family: "mass", toBase: 1 },
  kg: { family: "mass", toBase: 1000 },
  deg: { family: "angle", toBase: 1 },
};

/** Converts between units of the same family; null if the families differ. */
export function convert(value: number, from: z.infer<typeof Unit>, to: z.infer<typeof Unit>): number | null {
  const [a, b] = [FAMILY[from], FAMILY[to]];
  if (a.family !== b.family) return null;
  return Math.round(((value * a.toBase) / b.toBase) * 1e9) / 1e9;
}

export interface CharacteristicResult {
  characteristic: string;
  result: MeasurementResult;
  reasons: string[];
  /** Measured value in the characteristic's unit, when convertible. */
  value?: number;
  expandedUncertainty?: number;
}

export function evaluateMeasurement(c: Characteristic, m: Measurement | undefined, evidenceIds: ReadonlySet<string>): CharacteristicResult {
  const out = (result: MeasurementResult, reasons: string[], extra: Partial<CharacteristicResult> = {}): CharacteristicResult => ({
    characteristic: c.id, result, reasons, ...extra,
  });
  if (!m) return out("indeterminate", ["not measured"]);
  const reasons: string[] = [];
  const x = convert(m.value, m.unit, c.unit);
  if (x === null) return out("indeterminate", [`measured in ${m.unit}, characteristic is in ${c.unit}: incompatible units`]);
  if (!m.instrument) reasons.push("no instrument identified");
  else {
    if (!m.instrument.calibrationEvidence) reasons.push(`instrument ${m.instrument.id} has no calibration evidence`);
    else if (!evidenceIds.has(m.instrument.calibrationEvidence)) reasons.push(`calibration evidence ${m.instrument.calibrationEvidence} is not attached to the record`);
    if (!m.instrument.calibrationValidUntil) reasons.push(`instrument ${m.instrument.id} calibration has no due date`);
    else if (Date.parse(m.instrument.calibrationValidUntil) < Date.parse(m.measuredAt)) reasons.push(`instrument ${m.instrument.id} calibration expired ${m.instrument.calibrationValidUntil}, before the measurement`);
  }
  if (!m.uncertainty) reasons.push("no measurement uncertainty stated");
  const U = m.uncertainty ? convert(m.uncertainty.expanded, m.uncertainty.unit, c.unit) : null;
  if (m.uncertainty && U === null) reasons.push(`uncertainty in ${m.uncertainty.unit} is incompatible with ${c.unit}`);
  if (reasons.length || U === null) return out("indeterminate", reasons, { value: x });

  if (c.decisionRule === "guard-banded") {
    if (x >= c.lower + U && x <= c.upper - U) return out("accept", [`${x} ${c.unit} within [${c.lower} + U, ${c.upper} − U], U = ${U}`], { value: x, expandedUncertainty: U });
    if (x < c.lower - U || x > c.upper + U) return out("reject", [`${x} ${c.unit} outside the limits by more than U = ${U}`], { value: x, expandedUncertainty: U });
    return out("indeterminate", [`${x} ${c.unit} is within U = ${U} of a limit: conformance can't be decided (guard-banded rule)`], { value: x, expandedUncertainty: U });
  }
  const minTur = c.minTur ?? 4;
  const tur = U === 0 ? Infinity : (c.upper - c.lower) / (2 * U);
  if (tur < minTur) return out("indeterminate", [`test uncertainty ratio ${tur.toFixed(2)} is below ${minTur}: simple acceptance not permitted`], { value: x, expandedUncertainty: U });
  return x >= c.lower && x <= c.upper
    ? out("accept", [`${x} ${c.unit} within [${c.lower}, ${c.upper}] (TUR ${tur === Infinity ? "∞" : tur.toFixed(2)})`], { value: x, expandedUncertainty: U })
    : out("reject", [`${x} ${c.unit} outside [${c.lower}, ${c.upper}]`], { value: x, expandedUncertainty: U });
}

export interface InspectionEvaluation {
  outcome: MeasurementResult;
  results: CharacteristicResult[];
}

/**
 * Evaluates every planned characteristic. Any reject → reject; otherwise any indeterminate or
 * unmeasured characteristic → indeterminate (held); only a full set of accepts is accept.
 */
export function evaluateInspection(planned: readonly Characteristic[], measurements: readonly Measurement[], evidenceIds: ReadonlySet<string>): InspectionEvaluation {
  const results = planned.map((c) => {
    const ms = measurements.filter((m) => m.characteristic === c.id);
    if (ms.length > 1) return { characteristic: c.id, result: "indeterminate" as const, reasons: ["measured more than once in one record; record repeats separately"] };
    return evaluateMeasurement(c, ms[0], evidenceIds);
  });
  for (const m of measurements)
    if (!planned.some((c) => c.id === m.characteristic))
      results.push({ characteristic: m.characteristic, result: "indeterminate", reasons: ["not a planned characteristic for this inspection"] });
  const outcome: MeasurementResult = results.some((r) => r.result === "reject")
    ? "reject"
    : results.length === 0 || results.some((r) => r.result === "indeterminate")
      ? "indeterminate"
      : "accept";
  return { outcome, results };
}
