import {
  EVALUATION_COMPOSITE_MIN_INCLUDED,
  EVALUATION_OPERATING_WEIGHTS,
  EVALUATION_OUTCOME_WEIGHTS,
  type EvaluationConfidenceTier,
  type EvaluationMetricKey,
} from "@paperclipai/shared";
import { minTier, rank } from "./confidence.js";
import type { CompositeResult, MetricResult } from "./types.js";

export const COMPOSITE_FORMULA_VERSION = "composite/1";

/**
 * Spec §5.3: a renormalised weighted mean over included metrics,
 * `score = Σ wᵢ·vᵢ / Σ wᵢ`, values scaled to 0–100 and inverted where lower is
 * better. A metric is included only at Low confidence or better and only when
 * it has a weight. Guards: no outcome score with fewer than two included
 * metrics, no operating score with fewer than three. Composite confidence is
 * the lowest included tier. E3/E4 are flags, never arithmetic.
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
    included.push({ key, weight, scaled, confidence: m.confidence });
  }
  for (const key of Object.keys(metrics).sort() as EvaluationMetricKey[]) {
    if (!(key in weights) && metrics[key]) excluded.push({ key, reason: "shown, never scored" });
  }
  const guardOk = included.length >= minIncluded;
  let score: number | null = null;
  let confidence: EvaluationConfidenceTier | null = null;
  if (guardOk) {
    const wsum = included.reduce((s, i) => s + i.weight, 0);
    score = Math.round((included.reduce((s, i) => s + i.weight * i.scaled, 0) / wsum) * 10) / 10;
    confidence = included.map((i) => i.confidence).reduce((a, b) => minTier(a, b));
  }
  return {
    kind,
    score,
    confidence,
    included: included.sort((a, b) => (a.key < b.key ? -1 : 1)),
    excluded: excluded.sort((a, b) => (a.key < b.key ? -1 : 1)),
    flags: [...flags].sort(),
    guard: { minIncluded, satisfied: guardOk },
    formulaVersion: COMPOSITE_FORMULA_VERSION,
  };
}

/** Ratios become 0–100; index metrics (lower is better) are inverted and clamped: `100 · max(0, 1 − value)`. */
export function scaleTo100(m: MetricResult): number {
  const v = m.value ?? 0;
  if (m.lowerIsBetter) return Math.round(Math.max(0, Math.min(1, 1 - v)) * 1000) / 10;
  return Math.round(Math.max(0, Math.min(1, v)) * 1000) / 10;
}

export function isIncludable(tier: EvaluationConfidenceTier): boolean {
  return rank(tier) >= rank("low");
}
