/**
 * AgentDash — Chief of Staff plan rubric (AGE-41).
 *
 * Deterministic rubric for grading AgentTeamPlanPayload outputs against the
 * "A+ strategy quality" bar. Eight dimensions, each 0-10. Treated as an
 * "LLM judge surrogate" — the logic approximates what a strong human reviewer
 * would score, while running offline so CI can enforce it.
 *
 * Dimensions
 * ----------
 * 1. specificity     — is the plan specific to the goal, or generic?
 * 2. feasibility     — can a small team execute this in the horizon?
 * 3. roi_clarity     — is the cost/benefit framing explicit and reasonable?
 * 4. sequencing      — are the playbooks ordered + time-boxed?
 * 5. evidence        — are benchmarks cited for KPIs?
 * 6. novelty         — does it avoid duplicating the existing roster?
 * 7. accountability  — does every KPI + playbook name an owner role?
 * 8. risk            — are risks surfaced and mitigations proposed?
 *
 * A+ bar: average ≥ 8/10, every dimension ≥ 8/10.
 * Hard failure: any dimension < 6/10 → generator should return `{error}`.
 */

import type { AgentTeamPlanPayload } from "@agentdash/shared";
import type { CompanyContextBundle } from "./agent-plans-generator.js";

export const RUBRIC_DIMENSIONS = [
  "specificity",
  "feasibility",
  "roi_clarity",
  "sequencing",
  "evidence",
  "novelty",
  "accountability",
  "risk",
] as const;

export type RubricDimension = (typeof RUBRIC_DIMENSIONS)[number];

export type RubricScores = Record<RubricDimension, number>;

export interface RubricResult {
  scores: RubricScores;
  average: number;
  minimum: number;
  passesAPlus: boolean; // avg ≥ 8 AND every dim ≥ 8
  hardFailure: boolean; // any dim < 6
  notes: Partial<Record<RubricDimension, string>>;
}

function clamp(n: number): number {
  return Math.max(0, Math.min(10, Math.round(n * 10) / 10));
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Individual scorers
// ---------------------------------------------------------------------------

function scoreSpecificity(
  plan: AgentTeamPlanPayload,
  context: CompanyContextBundle | null,
): { score: number; note: string } {
  // Signals of specificity: rationale mentions the goal text, mentions
  // industry/size, mentions named agents' roles, and is long enough.
  const rat = plan.rationale ?? "";
  let score = 0;
  if (context && rat.toLowerCase().includes(context.goal.title.toLowerCase())) score += 2;
  if (context && context.industry && rat.toLowerCase().includes(context.industry.toLowerCase())) score += 1.5;
  if (context && context.companyName && rat.includes(context.companyName)) score += 1.5;
  if (plan.proposedAgents.every((a) => rat.includes(a.role))) score += 2;
  // Length gate — plans under 200 words can't pass specificity.
  const words = wordCount(rat);
  if (words >= 200) score += 3;
  else if (words >= 150) score += 2;
  else if (words >= 100) score += 1;
  return { score: clamp(score), note: `rationale=${words}w` };
}

function scoreFeasibility(
  plan: AgentTeamPlanPayload,
): { score: number; note: string } {
  let score = 10;
  // Too many agents => harder to execute
  if (plan.proposedAgents.length > 5) score -= 3;
  if (plan.proposedAgents.length > 7) score -= 3;
  // Playbooks with absurd cadence are infeasible.
  for (const pb of plan.proposedPlaybooks ?? []) {
    if (pb.stages.length > 8) score -= 1;
  }
  // Budget must cover the proposed roster.
  const rosterCost = plan.proposedAgents.reduce(
    (s, a) => s + (a.estimatedMonthlyCostUsd ?? 0),
    0,
  );
  if (plan.budget.monthlyCapUsd < rosterCost) score -= 5;
  // Bonus for lean teams (2-4 agents).
  if (plan.proposedAgents.length >= 1 && plan.proposedAgents.length <= 4) score += 0;
  else if (plan.proposedAgents.length === 0) score = 0;
  return { score: clamp(score), note: `agents=${plan.proposedAgents.length}` };
}

function scoreRoiClarity(
  plan: AgentTeamPlanPayload,
): { score: number; note: string } {
  let score = 0;
  // Budget has an explicit cap > 0
  if (plan.budget.monthlyCapUsd > 0) score += 3;
  // Kill-switch + warn threshold
  if (plan.budget.killSwitchAtPct > 0) score += 1;
  if (plan.budget.warnAtPct > 0) score += 1;
  // KPIs have targets distinct from baselines
  const kpiMeaningful = (plan.kpis ?? []).every(
    (k) => Number.isFinite(k.target) && k.target !== k.baseline,
  );
  if (kpiMeaningful) score += 3;
  // Rationale mentions dollars or ROI
  if (/\$|usd|roi|return|cost/i.test(plan.rationale)) score += 2;
  return { score: clamp(score), note: `kpis=${(plan.kpis ?? []).length}` };
}

function scoreSequencing(
  plan: AgentTeamPlanPayload,
): { score: number; note: string } {
  let score = 0;
  const pbs = plan.proposedPlaybooks ?? [];
  // A single well-scoped playbook (stages + trigger) earns a solid 8; the
  // remaining 2pts reward plans that sequence multiple playbooks.
  if (pbs.length >= 1) score += 5;
  if (pbs.length >= 2) score += 2;
  if (pbs.length >= 1 && pbs.every((p) => p.stages.length >= 1)) score += 2;
  if (pbs.some((p) => p.trigger)) score += 1;
  // Rationale explicitly names sequencing / cadence
  if (/sequenc|weekly|cadence|order|→/i.test(plan.rationale)) score += 1;
  return { score: clamp(score), note: `playbooks=${pbs.length}` };
}

function scoreEvidence(
  plan: AgentTeamPlanPayload,
): { score: number; note: string } {
  let score = 0;
  const rat = plan.rationale ?? "";
  // Cites named sources
  const citations = (rat.match(/\b(Gartner|SalesLoft|Lavender|OpenView|Ahrefs|Mixpanel|Flexera|McKinsey|Zendesk|Animalz|AgentDash internal|AgentDash benchmark)/gi) ?? []).length;
  if (citations >= 1) score += 3;
  if (citations >= 2) score += 2;
  if (citations >= 3) score += 2;
  // KPIs have non-empty units + horizons
  const kpiEvidenced = (plan.kpis ?? []).every((k) => k.unit && k.horizonDays > 0);
  if (kpiEvidenced) score += 3;
  return { score: clamp(score), note: `citations=${citations}` };
}

function scoreNovelty(
  plan: AgentTeamPlanPayload,
  context: CompanyContextBundle | null,
): { score: number; note: string } {
  if (!context) return { score: 8, note: "no-context" };
  const existing = new Set(context.existingAgents.map((a) => a.role));
  const proposed = plan.proposedAgents.map((a) => a.role);
  const duplicates = proposed.filter((r) => existing.has(r)).length;
  const uniqueCombos = new Set(
    plan.proposedAgents.map((a) => `${a.role}::${a.skills.slice().sort().join(",")}`),
  );
  let score = 10;
  if (duplicates > 0) score -= duplicates * 4;
  if (uniqueCombos.size !== plan.proposedAgents.length) score -= 3;
  return { score: clamp(score), note: `dups=${duplicates}` };
}

function scoreAccountability(
  plan: AgentTeamPlanPayload,
): { score: number; note: string } {
  let score = 0;
  const roleSet = new Set(plan.proposedAgents.map((a) => a.role));
  // Every playbook stage has an agentRole that matches a proposed agent (for
  // "agent" type stages).
  const pbs = plan.proposedPlaybooks ?? [];
  if (pbs.length === 0) {
    // No playbook → accountability rides on agents alone; partial credit.
    score += 4;
  } else {
    const allMatch = pbs.every((p) =>
      p.stages
        .filter((s) => s.type === "agent")
        .every((s) => s.agentRole && roleSet.has(s.agentRole)),
    );
    if (allMatch) score += 6;
  }
  // Every agent has a non-trivial system prompt
  if (plan.proposedAgents.every((a) => a.systemPrompt.length >= 40)) score += 2;
  // Every agent names at least one skill
  if (plan.proposedAgents.every((a) => (a.skills ?? []).length >= 1)) score += 2;
  return { score: clamp(score), note: `roles=${plan.proposedAgents.length}` };
}

function scoreRisk(
  plan: AgentTeamPlanPayload,
): { score: number; note: string } {
  let score = 0;
  const rat = plan.rationale ?? "";
  // Risks + mitigations called out explicitly
  const hasRiskKeyword = /\brisk(s)?\b/i.test(rat);
  const hasMitigation = /\bmitigat/i.test(rat);
  if (hasRiskKeyword) score += 3;
  if (hasMitigation) score += 3;
  // Budget guardrails present
  if (plan.budget.killSwitchAtPct <= 100 && plan.budget.killSwitchAtPct > 0) score += 2;
  if (plan.budget.warnAtPct < plan.budget.killSwitchAtPct) score += 2;
  return { score: clamp(score), note: `risk_kw=${hasRiskKeyword}` };
}

// ---------------------------------------------------------------------------
// Public scorer
// ---------------------------------------------------------------------------

export function scorePlan(
  plan: AgentTeamPlanPayload,
  context: CompanyContextBundle | null = null,
): RubricResult {
  const specificity = scoreSpecificity(plan, context);
  const feasibility = scoreFeasibility(plan);
  const roi = scoreRoiClarity(plan);
  const sequencing = scoreSequencing(plan);
  const evidence = scoreEvidence(plan);
  const novelty = scoreNovelty(plan, context);
  const accountability = scoreAccountability(plan);
  const risk = scoreRisk(plan);

  const scores: RubricScores = {
    specificity: specificity.score,
    feasibility: feasibility.score,
    roi_clarity: roi.score,
    sequencing: sequencing.score,
    evidence: evidence.score,
    novelty: novelty.score,
    accountability: accountability.score,
    risk: risk.score,
  };

  const values = Object.values(scores);
  const average = values.reduce((a, b) => a + b, 0) / values.length;
  const minimum = Math.min(...values);

  return {
    scores,
    average,
    minimum,
    passesAPlus: average >= 8 && minimum >= 8,
    hardFailure: minimum < 6,
    notes: {
      specificity: specificity.note,
      feasibility: feasibility.note,
      roi_clarity: roi.note,
      sequencing: sequencing.note,
      evidence: evidence.note,
      novelty: novelty.note,
      accountability: accountability.note,
      risk: risk.note,
    },
  };
}
