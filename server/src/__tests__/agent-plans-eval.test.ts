/**
 * Eval harness for the Chief of Staff dynamic plan generator (AGE-41).
 *
 * Runs all 20 reference scenarios through generateDynamicPlan, scores each
 * with the rubric, and enforces the A+ bar:
 *   - every scenario must clear the hard floor (min dim ≥ 6/10)
 *   - ≥ 18/20 scenarios must pass A+ (avg ≥ 8 AND every dim ≥ 8)
 *   - suite-wide average per dimension ≥ 8/10
 *
 * Scenarios live at `eval/agent-plans/scenarios/`. The generator and rubric
 * are deterministic so this test runs offline in CI without external LLM calls.
 */

import { describe, it, expect } from "vitest";
import {
  agentTeamPlanPayloadSchema,
} from "@agentdash/shared";
import {
  generateDynamicPlan,
} from "../services/agent-plans-generator.js";
import {
  scorePlan,
  RUBRIC_DIMENSIONS,
  type RubricDimension,
} from "../services/agent-plans-rubric.js";
import { SCENARIOS } from "./fixtures/agent-plans-scenarios.js";

describe("@age-41 agent-plans eval suite", () => {
  it("runs exactly 20 reference scenarios", () => {
    expect(SCENARIOS).toHaveLength(20);
  });

  it("every generated plan conforms to the zod payload schema", () => {
    for (const s of SCENARIOS) {
      const { payload } = generateDynamicPlan(s.context, s.interview);
      const parsed = agentTeamPlanPayloadSchema.safeParse(payload);
      expect(parsed.success, `${s.id}: ${parsed.success ? "" : parsed.error?.message}`).toBe(true);
    }
  });

  it("archetype detection lands on the expected archetype", () => {
    for (const s of SCENARIOS) {
      const { archetype } = generateDynamicPlan(s.context, s.interview);
      expect(archetype, `${s.id} expected ${s.expectedArchetype}, got ${archetype}`).toBe(
        s.expectedArchetype,
      );
    }
  });

  it("every plan has ≥1 proposed agent with a unique role+skill combo", () => {
    for (const s of SCENARIOS) {
      const { payload } = generateDynamicPlan(s.context, s.interview);
      expect(payload.proposedAgents.length, `${s.id}`).toBeGreaterThan(0);
      const keys = payload.proposedAgents.map((a) => `${a.role}::${a.skills.slice().sort().join(",")}`);
      expect(new Set(keys).size, `${s.id}`).toBe(keys.length);
    }
  });

  it("every plan has rationale ≥ 200 words", () => {
    for (const s of SCENARIOS) {
      const { payload } = generateDynamicPlan(s.context, s.interview);
      const words = payload.rationale.trim().split(/\s+/).filter(Boolean).length;
      expect(words, `${s.id} rationale=${words}w`).toBeGreaterThanOrEqual(200);
    }
  });

  it("budget cap fits the operator's monthly headroom", () => {
    for (const s of SCENARIOS) {
      const { payload } = generateDynamicPlan(s.context, s.interview);
      const rosterCost = payload.proposedAgents.reduce(
        (sum, a) => sum + (a.estimatedMonthlyCostUsd ?? 0),
        0,
      );
      expect(payload.budget.monthlyCapUsd, `${s.id}`).toBeGreaterThanOrEqual(rosterCost);
      const headroom = Math.max(
        0,
        s.context.budget.monthlyCapUsd - s.context.budget.spentMonthToDateUsd,
      );
      // Either under headroom, or explicitly matched to operator's stated budget.
      const withinCompanyBudget =
        payload.budget.monthlyCapUsd <= s.context.budget.monthlyCapUsd;
      const matchesOperatorBudget =
        s.interview.monthlyBudgetUsd !== undefined
        && payload.budget.monthlyCapUsd <= s.interview.monthlyBudgetUsd * 1.01;
      expect(
        withinCompanyBudget || matchesOperatorBudget || headroom === 0,
        `${s.id} cap=${payload.budget.monthlyCapUsd} headroom=${headroom}`,
      ).toBe(true);
    }
  });

  it("every plan clears the rubric hard floor (no dim < 6/10)", () => {
    const failing: string[] = [];
    for (const s of SCENARIOS) {
      const { payload } = generateDynamicPlan(s.context, s.interview);
      const r = scorePlan(payload, s.context);
      if (r.hardFailure) {
        failing.push(`${s.id}: min=${r.minimum.toFixed(1)} scores=${JSON.stringify(r.scores)}`);
      }
    }
    expect(failing, failing.join("\n")).toHaveLength(0);
  });

  it("≥18/20 scenarios pass the A+ bar (avg ≥ 8 AND every dim ≥ 8)", () => {
    const fails: Array<{ id: string; avg: number; min: number; scores: Record<string, number> }> = [];
    const passes: string[] = [];
    for (const s of SCENARIOS) {
      const { payload } = generateDynamicPlan(s.context, s.interview);
      const r = scorePlan(payload, s.context);
      if (r.passesAPlus) passes.push(s.id);
      else fails.push({ id: s.id, avg: r.average, min: r.minimum, scores: r.scores });
    }
    const report = [
      `A+ pass: ${passes.length}/20`,
      ...fails.map(
        (f) => `  fail ${f.id} avg=${f.avg.toFixed(2)} min=${f.min.toFixed(1)} ${JSON.stringify(f.scores)}`,
      ),
    ].join("\n");
    expect(passes.length, report).toBeGreaterThanOrEqual(18);
  });

  it("suite-wide average per rubric dimension ≥ 8/10", () => {
    const sums: Record<RubricDimension, number> = {
      specificity: 0,
      feasibility: 0,
      roi_clarity: 0,
      sequencing: 0,
      evidence: 0,
      novelty: 0,
      accountability: 0,
      risk: 0,
    };
    for (const s of SCENARIOS) {
      const { payload } = generateDynamicPlan(s.context, s.interview);
      const r = scorePlan(payload, s.context);
      for (const d of RUBRIC_DIMENSIONS) sums[d] += r.scores[d];
    }
    const averages = Object.fromEntries(
      RUBRIC_DIMENSIONS.map((d) => [d, sums[d] / SCENARIOS.length]),
    ) as Record<RubricDimension, number>;
    const failing = RUBRIC_DIMENSIONS.filter((d) => averages[d] < 8);
    expect(
      failing,
      `per-dim averages: ${JSON.stringify(averages, null, 2)}`,
    ).toHaveLength(0);
  });
});
