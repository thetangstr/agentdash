// AgentDash (AGE-48 Phase 1): Chief-of-Staff auto-propose orchestrator tests.
//
// Verifies that:
//   1. `goalService.create(...)` without `skipAutoPropose` produces an
//      `agent_plans` row with `status='proposed'` for the new goal.
//   2. `goalService.create(...)` WITH `skipAutoPropose: true` does NOT
//      produce a plan row.
//   3. An activity log entry with `action='plan.proposed'` is written
//      alongside the proposed plan.
//
// We follow the existing service-test convention in this repo: a minimal
// drizzle mock exposes the chainable builder, and we mock the collaborating
// services (`agent-plans.ts`, `activity-log.ts`) so we can assert on how
// the orchestrator glues them together without standing up embedded-pg.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- hoisted mocks (must be visible to the vi.mock factories below) ------

const mockGeneratePlan = vi.hoisted(() => vi.fn());
const mockPlanCreate = vi.hoisted(() => vi.fn());
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/agent-plans.js", () => ({
  agentPlansService: () => ({
    generatePlan: mockGeneratePlan,
    create: mockPlanCreate,
  }),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

// Minimal drizzle-like thenable chain used by goalService.create().
type Row = Record<string, unknown>;
function thenable(rows: Row[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockReturnValue(chain);
  chain.orderBy = vi.fn().mockReturnValue(chain);
  chain.values = vi.fn().mockReturnValue(chain);
  chain.set = vi.fn().mockReturnValue(chain);
  chain.returning = vi.fn().mockReturnValue(chain);
  chain.onConflictDoNothing = vi.fn().mockReturnValue(chain);
  chain.then = (onFulfilled: (v: Row[]) => unknown) => Promise.resolve(onFulfilled(rows));
  return chain;
}

const validPayload = {
  archetype: "revenue" as const,
  rationale: "Drive pipeline through outbound prospecting",
  proposedAgents: [
    {
      role: "sdr",
      name: "Outbound SDR",
      adapterType: "process",
      systemPrompt: "You are an outbound SDR.",
      skills: ["email", "crm"],
      estimatedMonthlyCostUsd: 120,
    },
  ],
  proposedPlaybooks: [],
  budget: { monthlyCapUsd: 500, killSwitchAtPct: 100, warnAtPct: 80 },
  kpis: [
    { metric: "meetings_booked", baseline: 0, target: 10, unit: "count", horizonDays: 30 },
  ],
};

// ---- shared setup ---------------------------------------------------------

const companyId = "co-1";
// AgentDash (AGE-50 Phase 4b): team-level by default so existing tests
// still exercise the auto-propose path. Company-level now triggers the
// skip-for-interview branch — covered by its own test below.
const goalRow = {
  id: "g-new",
  companyId,
  title: "Q1 team revenue standup",
  description: "ship ICP-focused outbound",
  level: "team",
  status: "planned",
};

function makeDb(options: { existingGoalForLookup?: boolean } = {}) {
  const selectImpl = vi.fn();
  if (options.existingGoalForLookup !== false) {
    // goalService.getById(created.id) lookup inside cos-orchestrator.
    selectImpl.mockReturnValueOnce(thenable([goalRow]));
  }
  const insertImpl = vi.fn().mockReturnValue(thenable([goalRow]));
  const updateImpl = vi.fn().mockReturnValue(thenable([]));
  return {
    select: selectImpl,
    insert: insertImpl,
    update: updateImpl,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cosOrchestratorService.proposeForGoal (wired via goalService.create)", () => {
  it("auto-proposes a plan with status='proposed' and writes plan.proposed activity", async () => {
    // Arrange: happy-path generator output + plan row.
    mockGeneratePlan.mockResolvedValueOnce({
      plan: validPayload,
      archetype: "revenue",
      interviewHash: "hash-1",
      rubric: { average: 8.5, minimum: 8, passesAPlus: true, hardFailure: false, scores: {} },
      cached: false,
    });
    const planRow = {
      id: "plan-new-1",
      companyId,
      goalId: goalRow.id,
      status: "proposed",
      archetype: "revenue",
      proposalPayload: validPayload,
    };
    mockPlanCreate.mockResolvedValueOnce(planRow);

    const { goalService } = await import("../services/goals.js");
    const db = makeDb();

    // Act
    const created = await goalService(db as any).create(companyId, {
      title: goalRow.title,
      description: goalRow.description,
      level: "team" as any,
      status: "planned" as any,
    });

    // Assert: insert into goals ran, then orchestrator ran.
    expect(created?.id).toBe(goalRow.id);
    expect(mockGeneratePlan).toHaveBeenCalledTimes(1);
    expect(mockGeneratePlan).toHaveBeenCalledWith(
      companyId,
      goalRow.id,
      expect.objectContaining({ goalStatement: expect.any(String) }),
    );
    expect(mockPlanCreate).toHaveBeenCalledTimes(1);
    expect(mockPlanCreate).toHaveBeenCalledWith(
      companyId,
      expect.objectContaining({
        goalId: goalRow.id,
        archetype: "revenue",
        payload: validPayload,
      }),
      expect.objectContaining({ agentId: undefined }),
    );
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    const activityArgs = mockLogActivity.mock.calls[0][1];
    expect(activityArgs).toMatchObject({
      companyId,
      action: "plan.proposed",
      entityType: "goal",
      entityId: goalRow.id,
      details: expect.objectContaining({ planId: planRow.id, archetype: "revenue" }),
    });
  });

  it("skipAutoPropose=true suppresses plan generation and activity logging", async () => {
    const { goalService } = await import("../services/goals.js");
    const db = makeDb({ existingGoalForLookup: false });

    await goalService(db as any).create(
      companyId,
      {
        title: "seed-only goal",
        level: "team" as any,
        status: "planned" as any,
      },
      { skipAutoPropose: true },
    );

    expect(mockGeneratePlan).not.toHaveBeenCalled();
    expect(mockPlanCreate).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("swallows generator errors so goal creation remains green", async () => {
    // Arrange: generator returns a rubric failure.
    mockGeneratePlan.mockResolvedValueOnce({
      error: "Plan failed rubric hard-floor (min=3.0/10)",
      rubric: { average: 4, minimum: 3, passesAPlus: false, hardFailure: true, scores: {} },
    });

    const { goalService } = await import("../services/goals.js");
    const db = makeDb();

    const created = await goalService(db as any).create(companyId, {
      title: goalRow.title,
      level: "team" as any,
      status: "planned" as any,
    });

    // Goal creation still succeeds.
    expect(created?.id).toBe(goalRow.id);
    // No plan row was created, no activity logged.
    expect(mockPlanCreate).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("skips auto-propose for company-level goals with thin descriptions (AGE-50 Phase 4b)", async () => {
    // Company-level goals require a Socratic deep-interview when the
    // description lacks enough signal to generate a grounded plan.
    const companyGoalRow = { ...goalRow, level: "company", description: "" };
    const selectImpl = vi.fn().mockReturnValueOnce(thenable([companyGoalRow]));
    const insertImpl = vi.fn().mockReturnValue(thenable([companyGoalRow]));
    const db = {
      select: selectImpl,
      insert: insertImpl,
      update: vi.fn().mockReturnValue(thenable([])),
    };

    const { goalService } = await import("../services/goals.js");
    const created = await goalService(db as any).create(companyId, {
      title: "Launch premium tier by EOQ2",
      level: "company" as any,
      status: "planned" as any,
    });

    // Goal creation succeeds.
    expect(created?.id).toBe(companyGoalRow.id);
    // Auto-propose was skipped — no plan generation, no plan row, no activity.
    expect(mockGeneratePlan).not.toHaveBeenCalled();
    expect(mockPlanCreate).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("auto-proposes for company-level goals with substantive descriptions (AGE-50 Phase 5)", async () => {
    // When the operator supplies a rich, specific description the
    // ambiguity gate treats the description itself as the interview and
    // the generator can run directly — avoids forcing a Socratic Q&A on
    // operators who already answered the questions in prose.
    const richDescription =
      "Launch the premium tier end-of-quarter with three concrete bets: " +
      "Stripe billing integration, a public pricing and packaging page, " +
      "and targeted outreach to existing B2B customers above $10k ARR. " +
      "Constraints: no cold outreach to net-new prospects, must preserve " +
      "our free tier, budget cap $2k monthly for agent runtime. Channels: " +
      "email and in-app messaging. Success: 10 premium conversions and " +
      "$30k new MRR in 90 days.";
    const companyGoalRow = {
      ...goalRow,
      level: "company",
      description: richDescription,
    };

    mockGeneratePlan.mockResolvedValueOnce({
      plan: validPayload,
      archetype: "revenue",
      interviewHash: "h-phase5",
      rubric: { average: 8.2, minimum: 8, passesAPlus: true, hardFailure: false, scores: {} },
      cached: false,
    });
    mockPlanCreate.mockResolvedValueOnce({
      id: "plan-phase5",
      companyId,
      goalId: companyGoalRow.id,
      status: "proposed",
      archetype: "revenue",
      proposalPayload: validPayload,
    });

    const selectImpl = vi.fn().mockReturnValueOnce(thenable([companyGoalRow]));
    const insertImpl = vi.fn().mockReturnValue(thenable([companyGoalRow]));
    const db = {
      select: selectImpl,
      insert: insertImpl,
      update: vi.fn().mockReturnValue(thenable([])),
    };

    const { goalService } = await import("../services/goals.js");
    const created = await goalService(db as any).create(companyId, {
      title: "Launch premium tier by EOQ2",
      description: richDescription,
      level: "company" as any,
      status: "planned" as any,
    });

    expect(created?.id).toBe(companyGoalRow.id);
    // Auto-propose ran — substantive description bypassed the interview gate.
    expect(mockGeneratePlan).toHaveBeenCalledTimes(1);
    expect(mockPlanCreate).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
  });

  it("swallows thrown errors from the orchestrator and still returns the goal", async () => {
    // Arrange: generator throws a surprise exception (simulates DB or LLM
    // failure). proposeForGoal should swallow so goal.create stays green.
    mockGeneratePlan.mockRejectedValueOnce(new Error("boom"));

    const { goalService } = await import("../services/goals.js");
    const db = makeDb();

    const created = await goalService(db as any).create(companyId, {
      title: goalRow.title,
      level: "team" as any,
      status: "planned" as any,
    });

    expect(created?.id).toBe(goalRow.id);
    expect(mockPlanCreate).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});

describe("cosOrchestratorService.defaultInterviewPayload", () => {
  it("derives goalStatement from title+description", async () => {
    const { defaultInterviewPayload } = await import("../services/cos-orchestrator.js");
    const payload = defaultInterviewPayload({
      title: "Close 5 enterprise deals",
      description: "Prioritize HubSpot pipeline",
      level: "company",
    });
    expect(payload.goalStatement).toBe(
      "Close 5 enterprise deals: Prioritize HubSpot pipeline",
    );
    expect(payload.constraints).toEqual([]);
    expect(payload.channels).toEqual([]);
    expect(payload.blockers).toEqual([]);
  });

  it("falls back to title only when description is missing", async () => {
    const { defaultInterviewPayload } = await import("../services/cos-orchestrator.js");
    const payload = defaultInterviewPayload({ title: "Ship the demo" });
    expect(payload.goalStatement).toBe("Ship the demo");
  });
});
