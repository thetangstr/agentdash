import {
  EVALUATION_CONFIDENCE_LABELS,
  EVALUATION_TIER_THRESHOLDS,
  type EvaluationConfidenceTier,
  type EvaluationSourceTier,
} from "@paperclipai/shared";

/**
 * Spec §7: one confidence rule for every metric, from coverage.
 * High ≥ 0.8 with two independent tiers for decisive facts; Medium 0.5–0.8 or
 * single-tier or a derived contract; Low 0.2–0.5 or a T0/T0 disagreement (value
 * shown with a warning); Insufficient < 0.2 or by construction (no value).
 * Retrospective scoring caps at Medium (§4.6 "confidence capped").
 */
export interface ConfidenceInput {
  coverage: number;
  tiers: Iterable<EvaluationSourceTier>;
  derivedContract?: boolean;
  disagreement?: boolean;
  byConstruction?: boolean;
  retrospective?: boolean;
  /** Empty population: nothing to decide. */
  emptyPopulation?: boolean;
}

const ORDER: EvaluationConfidenceTier[] = ["insufficient", "low", "medium", "high"];

export function rank(t: EvaluationConfidenceTier): number {
  return ORDER.indexOf(t);
}

export function minTier(a: EvaluationConfidenceTier, b: EvaluationConfidenceTier): EvaluationConfidenceTier {
  return rank(a) <= rank(b) ? a : b;
}

export function tierFor(input: ConfidenceInput): { tier: EvaluationConfidenceTier; reasons: string[] } {
  const reasons: string[] = [];
  if (input.byConstruction) return { tier: "insufficient", reasons: ["insufficient by construction: a named prerequisite has not landed"] };
  if (input.emptyPopulation) return { tier: "insufficient", reasons: ["empty population"] };
  const c = Number.isFinite(input.coverage) ? Math.max(0, Math.min(1, input.coverage)) : 0;
  let tier: EvaluationConfidenceTier;
  if (c < EVALUATION_TIER_THRESHOLDS.low) {
    tier = "insufficient";
    reasons.push(`coverage ${pct(c)} below ${pct(EVALUATION_TIER_THRESHOLDS.low)}`);
  } else if (c < EVALUATION_TIER_THRESHOLDS.medium) {
    tier = "low";
    reasons.push(`coverage ${pct(c)}`);
  } else if (c < EVALUATION_TIER_THRESHOLDS.high) {
    tier = "medium";
    reasons.push(`coverage ${pct(c)}`);
  } else {
    const distinct = new Set(input.tiers);
    if (distinct.size >= 2) {
      tier = "high";
      reasons.push(`coverage ${pct(c)} with ${distinct.size} independent source tiers`);
    } else {
      tier = "medium";
      reasons.push(`coverage ${pct(c)} from a single source tier`);
    }
  }
  if (input.disagreement && rank(tier) > rank("low")) {
    tier = "low";
    reasons.push("two control-plane sources disagree; both kept, value shown with a warning");
  }
  if (input.derivedContract && rank(tier) > rank("medium")) {
    tier = "medium";
    reasons.push("contract derived by the evaluator, not declared: capped at adequate");
  }
  if (input.retrospective && rank(tier) > rank("medium")) {
    tier = "medium";
    reasons.push("scored retrospectively: capped at adequate");
  }
  return { tier, reasons };
}

export function labelFor(tier: EvaluationConfidenceTier): string {
  return EVALUATION_CONFIDENCE_LABELS[tier];
}

export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}
