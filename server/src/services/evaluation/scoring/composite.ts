import {
  EVALUATION_METRIC_NAMES,
  EVALUATION_COMPOSITE_COVERAGE_FLOOR,
  EVALUATION_COMPOSITE_MAX_CONCENTRATION,
  EVALUATION_COMPOSITE_MIN_INCLUDED,
  EVALUATION_OPERATING_WEIGHTS,
  EVALUATION_OUTCOME_WEIGHTS,
  type EvaluationConfidenceTier,
  type EvaluationMetricKey,
} from "@paperclipai/shared";
import { minTier } from "./confidence.js";
import type { CompositeResult, MetricResult } from "./types.js";

export const COMPOSITE_FORMULA_VERSION = "composite/6";
export const COMPOSITE_COVERAGE_FLOOR = EVALUATION_COMPOSITE_COVERAGE_FLOOR;
export const COMPOSITE_MAX_CONCENTRATION = EVALUATION_COMPOSITE_MAX_CONCENTRATION;

/**
 * Spec §5.3: a renormalised weighted mean over included metrics, values scaled
 * to 0–100 and inverted where lower is better. Each weight is multiplied by
 * the metric's coverage — `score = Σ wᵢ·cᵢ·vᵢ / Σ wᵢ·cᵢ` — because values are
 * over the decidable population and a number resting on a fifth of the items
 * must not count like one resting on all of them (§7). A metric is included
 * only at Low confidence or better and only when it has a weight. Guards: no
 * outcome score with fewer than two included metrics, no operating score with
 * fewer than three. Composite confidence is the lowest included tier. E3/E4
 * are flags, never arithmetic.
 */
export function composite(
  kind: "outcome" | "operating",
  metrics: Partial<Record<EvaluationMetricKey, MetricResult>>,
  flags: string[],
): CompositeResult {
  const weights = kind === "outcome" ? EVALUATION_OUTCOME_WEIGHTS : EVALUATION_OPERATING_WEIGHTS;
  const minIncluded = EVALUATION_COMPOSITE_MIN_INCLUDED[kind];
  const included: CompositeResult["included"] = [];
  const excluded: CompositeResult["excluded"] = [];
  const keys = Object.keys(weights).sort() as EvaluationMetricKey[];
  for (const key of keys) {
    const weight = weights[key]!;
    const m = metrics[key];
    if (!m) {
      excluded.push({ key, reason: "not computed" });
      continue;
    }
    if (m.displayOnly) {
      excluded.push({ key, reason: "shown, never scored" });
      continue;
    }
    if (m.confidence === "insufficient" || m.value === null) {
      excluded.push({ key, reason: `insufficient evidence: ${m.notes[0] ?? "no decidable population"}` });
      continue;
    }
    const scaled = scaleTo100(m);
    included.push({ key, weight, coverage: m.coverage, scaled, confidence: m.confidence });
  }
  for (const key of Object.keys(metrics).sort() as EvaluationMetricKey[]) {
    if (!(key in weights) && metrics[key]) excluded.push({ key, reason: "shown, never scored" });
  }
  const weightSum = included.reduce((s, i) => s + i.weight, 0);
  const wsum = included.reduce((s, i) => s + i.weight * i.coverage, 0);
  // how much of the included weight actually rests on decidable records
  const compositeCoverage = included.length > 0 && weightSum > 0 ? Math.round((wsum / weightSum) * 1000) / 1000 : null;
  // the largest share of effective weight any one metric supplies: a score must never be one metric's absence of records
  const concentration = wsum > 0 ? Math.max(...included.map((i) => (i.weight * i.coverage) / wsum)) : 0;
  const dominant = wsum > 0 ? included.reduce((best, i) => ((i.weight * i.coverage) / wsum > (best.weight * best.coverage) / wsum ? i : best), included[0]!) : null;
  // every violated guard is reported, the most specific first; with too few metrics the other two would be
  // tautologies pointing at the wrong remedy, so they are only judged once the minimum is met
  const reasons: string[] = [];
  if (included.length < minIncluded) reasons.push(`fewer than ${minIncluded} metrics have evidence`);
  else {
    if (concentration > COMPOSITE_MAX_CONCENTRATION && dominant) reasons.push(`${EVALUATION_METRIC_NAMES[dominant.key]} alone would supply ${Math.round(concentration * 100)}% of the score; no single metric may supply more than ${Math.round(COMPOSITE_MAX_CONCENTRATION * 100)}%`);
    if (compositeCoverage === null || compositeCoverage < COMPOSITE_COVERAGE_FLOOR) reasons.push(`the included metrics rest on ${compositeCoverage === null ? "no" : `${Math.round(compositeCoverage * 100)}% of the`} decidable records; at least ${Math.round(COMPOSITE_COVERAGE_FLOOR * 100)}% is needed`);
  }
  const guardOk = reasons.length === 0;
  let score: number | null = null;
  let confidence: EvaluationConfidenceTier | null = null;
  if (guardOk) {
    score = Math.round((included.reduce((s, i) => s + i.weight * i.coverage * i.scaled, 0) / wsum) * 10) / 10;
    confidence = included.map((i) => i.confidence).reduce((a, b) => minTier(a, b));
  }
  return {
    kind,
    score,
    confidence,
    coverage: compositeCoverage,
    included: included.sort((a, b) => (a.key < b.key ? -1 : 1)),
    excluded: excluded.sort((a, b) => (a.key < b.key ? -1 : 1)),
    flags: [...flags].sort(),
    guard: { minIncluded, coverageFloor: COMPOSITE_COVERAGE_FLOOR, maxConcentration: COMPOSITE_MAX_CONCENTRATION, concentration: Math.round(concentration * 1000) / 1000, satisfied: guardOk, reasons, ...(reasons.length > 0 ? { reason: reasons[0]! } : {}) },
    formulaVersion: COMPOSITE_FORMULA_VERSION,
  };
}

/** Ratios become 0–100; index metrics (lower is better) are inverted and clamped: `100 · max(0, 1 − value)`. */
export function scaleTo100(m: MetricResult): number {
  const v = m.value ?? 0;
  if (m.lowerIsBetter) return Math.round(Math.max(0, Math.min(1, 1 - v)) * 1000) / 10;
  return Math.round(Math.max(0, Math.min(1, v)) * 1000) / 10;
}
