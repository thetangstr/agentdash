// AgentDash: goals-hub service tests.
//
// Pure functions (computeKpiProgress) are exercised directly. The rollup
// assembly is tested with a routing mock DB: we capture the base drizzle table
// object used by each `db.select().from(table)` call and return a pre-seeded
// row array keyed on table name. This gives us full coverage of the rollup
// math (spend / revenue / KPI progress / work counts) without a live Postgres.

import { describe, it, expect } from "vitest";
import { computeKpiProgress, goalsHubService } from "../goals-hub.js";

describe("computeKpiProgress", () => {
  it("reports 50% progress when halfway between baseline and target", () => {
    const r = computeKpiProgress(
      { metric: "m", baseline: 0, target: 10, unit: "count", horizonDays: 30 },
      5,
    );
    expect(r.progressPercent).toBe(50);
    expect(r.onTrack).toBe(true);
    expect(r.deltaToTarget).toBe(5);
  });

  it("clamps progress to 0 when current is below baseline", () => {
    const r = computeKpiProgress(
      { metric: "m", baseline: 10, target: 20, unit: "count", horizonDays: 30 },
      0,
    );
    expect(r.progressPercent).toBe(0);
    expect(r.onTrack).toBe(false);
  });

  it("clamps progress to 200 when current overshoots target", () => {
    const r = computeKpiProgress(
      { metric: "m", baseline: 0, target: 10, unit: "count", horizonDays: 30 },
      100,
    );
    expect(r.progressPercent).toBe(200);
    expect(r.onTrack).toBe(true);
  });

  it("handles cost-down goals where target < baseline", () => {
    // baseline 100, target 50, current 75 → halfway reduction = 50% progress
    const r = computeKpiProgress(
      { metric: "m", baseline: 100, target: 50, unit: "cents", horizonDays: 30 },
      75,
    );
    expect(r.progressPercent).toBe(50);
    expect(r.onTrack).toBe(true);
    expect(r.deltaToTarget).toBe(-25);
  });

  it("treats zero-span KPI as on-track only when current >= target", () => {
    const kpi = { metric: "m", baseline: 5, target: 5, unit: "count", horizonDays: 30 };
    expect(computeKpiProgress(kpi, 5).onTrack).toBe(true);
    expect(computeKpiProgress(kpi, 4).onTrack).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rollup integration via mock DB
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

// We identify seed rows by a synthetic `__table` marker. The mock select()
// walks `from(table)` and returns the matching rows.
interface Seed {
  goal?: Row[];
  agentGoalsJoin?: Row[]; // rows returned from agentGoals join agents select
  agentPlans?: Row[];
  issuesAgg?: Row[]; // rows for grouped issues status
  routinesAgg?: Row[];
  pipelinesAgg?: Row[];
  costTotal?: number;
  revenueTotal?: number;
  budgetPolicy?: Row | null;
  issuesList?: Row[];
  activityLog?: Row[];
  heartbeatRuns?: Row[];
}

function buildMockDb(seed: Seed) {
  // Each select() call creates a fresh chain. We track which "logical target"
  // the caller is hitting by the order: the service's select sequence is
  // stable because it's driven by Promise.all and sequential awaits.
  let selectCalls = 0;

  const thenable = (rows: unknown) => {
    const chain: Record<string, unknown> = {};
    chain.from = (_tbl: unknown) => chain;
    chain.innerJoin = () => chain;
    chain.where = () => chain;
    chain.groupBy = () => chain;
    chain.orderBy = () => chain;
    chain.limit = () => chain;
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(onFulfilled(rows));
    return chain;
  };

  // Returns the right payload for the Nth select() call in the
  // deterministic sequence the service makes.
  const sequence: unknown[] = [
    seed.goal ?? [], // 0: assertGoalInCompany
    (seed.agentGoalsJoin ?? []).map((r) => ({ ...r })), // 1: loadRoster
    seed.agentPlans ?? [], // 2: loadOriginatingPlan
    seed.issuesAgg ?? [], // 3: loadWork -> issues
    seed.routinesAgg ?? [], // 4: loadWork -> routines
    seed.pipelinesAgg ?? [], // 5: loadWork -> pipelines
    [{ total: seed.costTotal ?? 0 }], // 6: spend - costs
    [{ total: seed.revenueTotal ?? 0 }], // 7: spend - revenue
    seed.budgetPolicy ? [seed.budgetPolicy] : [], // 8: budget
    seed.issuesList ?? [], // 9: activity - issue ids
    seed.activityLog ?? [], // 10: activity log
    seed.heartbeatRuns ?? [], // 11: heartbeat runs
  ];

  const db = {
    select: () => {
      const idx = selectCalls++;
      const payload = sequence[idx] ?? [];
      return thenable(payload);
    },
    insert: () => thenable([]),
    update: () => thenable([]),
  };
  return db;
}

describe("goalsHubService.getRollup", () => {
  const companyId = "00000000-0000-0000-0000-000000000001";
  const goalId = "00000000-0000-0000-0000-000000000002";
  const now = new Date("2026-04-20T12:00:00.000Z");

  it("throws when goal is not found for the company", async () => {
    const db = buildMockDb({ goal: [] });
    const svc = goalsHubService(db as unknown as Parameters<typeof goalsHubService>[0]);
    await expect(svc.getRollup(companyId, goalId, { now })).rejects.toThrow(/not found/i);
  });

  it("aggregates roster, work, spend and KPI rollup for a goal", async () => {
    const plan = {
      id: "plan-1",
      companyId,
      goalId,
      status: "expanded",
      archetype: "revenue",
      rationale: "Drive outbound pipeline",
      decisionNote: "Approved",
      proposalPayload: {
        archetype: "revenue",
        rationale: "Drive outbound pipeline",
        proposedAgents: [],
        proposedPlaybooks: [],
        budget: { monthlyCapUsd: 500, killSwitchAtPct: 100, warnAtPct: 80 },
        kpis: [
          {
            metric: "meetings_booked",
            baseline: 0,
            target: 10,
            unit: "count",
            horizonDays: 30,
          },
          {
            metric: "monthly_spend_cents",
            baseline: 0,
            target: 50_000,
            unit: "cents",
            horizonDays: 30,
          },
        ],
      },
      proposedByUserId: "user-1",
      approvedByUserId: "user-1",
      approvedAt: new Date("2026-04-15T00:00:00.000Z"),
      rejectedAt: null,
      createdAt: new Date("2026-04-10T00:00:00.000Z"),
    };

    const db = buildMockDb({
      goal: [{ id: goalId, companyId, title: "Q2 Revenue" }],
      agentGoalsJoin: [
        {
          agentId: "agent-1",
          name: "Outbound SDR",
          role: "sdr",
          status: "idle",
          adapterType: "process",
          budgetMonthlyCents: 20_000,
          spendMonthlyCents: 7_500,
          linkedAt: new Date("2026-04-15T00:00:00.000Z"),
        },
        {
          agentId: "agent-2",
          name: "Researcher",
          role: "researcher",
          status: "idle",
          adapterType: "process",
          budgetMonthlyCents: 10_000,
          spendMonthlyCents: 2_000,
          linkedAt: new Date("2026-04-16T00:00:00.000Z"),
        },
      ],
      agentPlans: [plan],
      issuesAgg: [
        { status: "backlog", count: 3 },
        { status: "in_progress", count: 2 },
        { status: "done", count: 5 },
      ],
      routinesAgg: [
        { status: "active", count: 1 },
        { status: "paused", count: 1 },
      ],
      pipelinesAgg: [
        { status: "active", count: 2 },
        { status: "archived", count: 1 },
      ],
      costTotal: 9_500,
      revenueTotal: 25_000,
      budgetPolicy: { id: "bp-1", amount: 50_000, isActive: true },
      issuesList: [{ id: "issue-1" }],
      activityLog: [
        {
          id: "al-1",
          createdAt: new Date("2026-04-18T00:00:00.000Z"),
          action: "issue.created",
          actorType: "user",
          actorId: "user-1",
          entityType: "issue",
          entityId: "issue-1",
          agentId: null,
        },
      ],
      heartbeatRuns: [
        {
          id: "run-1",
          createdAt: new Date("2026-04-19T10:00:00.000Z"),
          startedAt: new Date("2026-04-19T10:01:00.000Z"),
          status: "succeeded",
          agentId: "agent-1",
          issueId: "issue-1",
        },
      ],
    });

    const svc = goalsHubService(db as unknown as Parameters<typeof goalsHubService>[0]);
    const rollup = await svc.getRollup(companyId, goalId, { now });

    // Roster
    expect(rollup.agents).toHaveLength(2);
    expect(rollup.agents[0].agentId).toBe("agent-1");
    expect(rollup.agents[0].spendMonthlyCents).toBe(7_500);

    // Plan summary
    expect(rollup.plan?.id).toBe("plan-1");
    expect(rollup.plan?.status).toBe("expanded");
    expect(rollup.plan?.archetype).toBe("revenue");

    // Work
    expect(rollup.work.openIssueCount).toBe(5); // backlog + in_progress
    expect(rollup.work.activeRoutineCount).toBe(1);
    expect(rollup.work.activePipelineCount).toBe(2);
    expect(rollup.work.issuesByStatus.done).toBe(5);

    // Spend
    expect(rollup.spend.spendCents).toBe(9_500);
    expect(rollup.spend.revenueCents).toBe(25_000);
    expect(rollup.spend.netCents).toBe(15_500);
    expect(rollup.spend.budgetCents).toBe(50_000);
    expect(rollup.spend.percentOfBudget).toBe(19); // 9500/50000 = 19%

    // KPIs — meetings_booked stays at baseline; monthly_spend_cents uses spend
    const meetings = rollup.kpis.find((k) => k.metric === "meetings_booked");
    const spendKpi = rollup.kpis.find((k) => k.metric === "monthly_spend_cents");
    expect(meetings?.current).toBe(0);
    expect(meetings?.deltaToTarget).toBe(10);
    expect(meetings?.onTrack).toBe(false);
    expect(spendKpi?.current).toBe(9_500);
    expect(spendKpi?.progressPercent).toBe(19);

    // Activity — interleaved and sorted desc by occurredAt
    expect(rollup.activity.length).toBeGreaterThanOrEqual(2);
    expect(rollup.activity[0].kind).toBe("heartbeat_run"); // 2026-04-19 > 2026-04-18
    expect(rollup.activity[1].kind).toBe("activity_log");
  });

  it("returns empty-state rollup when no plan, no agents, no spend", async () => {
    const db = buildMockDb({
      goal: [{ id: goalId, companyId, title: "Unassigned" }],
      agentGoalsJoin: [],
      agentPlans: [],
      issuesAgg: [],
      routinesAgg: [],
      pipelinesAgg: [],
      costTotal: 0,
      revenueTotal: 0,
      budgetPolicy: null,
      issuesList: [],
      activityLog: [],
      heartbeatRuns: [],
    });

    const svc = goalsHubService(db as unknown as Parameters<typeof goalsHubService>[0]);
    const rollup = await svc.getRollup(companyId, goalId, { now });

    expect(rollup.agents).toEqual([]);
    expect(rollup.plan).toBeNull();
    expect(rollup.work.openIssueCount).toBe(0);
    expect(rollup.spend.spendCents).toBe(0);
    expect(rollup.spend.revenueCents).toBe(0);
    expect(rollup.spend.budgetCents).toBeNull();
    expect(rollup.spend.percentOfBudget).toBeNull();
    expect(rollup.kpis).toEqual([]);
    expect(rollup.activity).toEqual([]);
  });

  it("prefers the expanded plan over proposed/rejected", async () => {
    const expanded = {
      id: "plan-expanded",
      companyId,
      goalId,
      status: "expanded",
      archetype: "revenue",
      rationale: "r1",
      decisionNote: null,
      proposalPayload: {
        archetype: "revenue",
        rationale: "r1",
        proposedAgents: [],
        proposedPlaybooks: [],
        budget: { monthlyCapUsd: 100, killSwitchAtPct: 100, warnAtPct: 80 },
        kpis: [],
      },
      proposedByUserId: null,
      approvedByUserId: "u1",
      approvedAt: new Date("2026-04-10T00:00:00.000Z"),
      rejectedAt: null,
      createdAt: new Date("2026-04-05T00:00:00.000Z"),
    };
    const proposed = {
      ...expanded,
      id: "plan-proposed",
      status: "proposed",
      approvedByUserId: null,
      approvedAt: null,
      createdAt: new Date("2026-04-19T00:00:00.000Z"),
    };

    const db = buildMockDb({
      goal: [{ id: goalId, companyId, title: "G" }],
      agentGoalsJoin: [],
      agentPlans: [proposed, expanded],
      issuesAgg: [],
      routinesAgg: [],
      pipelinesAgg: [],
      costTotal: 0,
      revenueTotal: 0,
      budgetPolicy: null,
      issuesList: [],
      activityLog: [],
      heartbeatRuns: [],
    });

    const svc = goalsHubService(db as unknown as Parameters<typeof goalsHubService>[0]);
    const rollup = await svc.getRollup(companyId, goalId, { now });
    expect(rollup.plan?.id).toBe("plan-expanded");
  });
});
