/**
 * Unit tests for agentPlansService.generatePlan (AGE-41).
 *
 * Covers:
 *  - happy path: context fetched, plan generated, rubric passes, result cached
 *  - error path: goal not in company → structured error
 *  - caching: second call with same (goalId, interview) returns cached=true
 *  - novelty: avoids duplicating roles already in the roster
 *
 * We use a minimal drizzle-shape mock and route each `db.select()` call to
 * canned rows by tracking the call index in order of the generator's reads:
 *   (1) goals, (2) companies, (3) company_connectors, (4) agents, (5) agent_plans
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GoalInterviewPayload } from "@agentdash/shared";

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

vi.mock("../agents.js", () => ({
  agentService: () => ({
    create: vi.fn(async (_companyId: string, data: Row) => ({
      id: `agent-${String(data.name).toLowerCase()}`,
      ...data,
    })),
  }),
}));

function makeDb(opts: {
  goal?: Row | null;
  company?: Row | null;
  connectors?: Row[];
  existingAgents?: Row[];
  priorPlans?: Row[];
}) {
  const { goal, company, connectors = [], existingAgents = [], priorPlans = [] } = opts;
  // Each generatePlan invocation issues selects in this order.
  const responseQueue: Row[][] = [
    goal ? [goal] : [],
    company ? [company] : [],
    connectors,
    existingAgents,
    priorPlans,
  ];
  let cursor = 0;
  const select = vi.fn().mockImplementation(() => {
    const rows = responseQueue[cursor % responseQueue.length] ?? [];
    cursor += 1;
    return thenable(rows);
  });
  const insert = vi.fn().mockReturnValue(thenable([]));
  const update = vi.fn().mockReturnValue(thenable([]));
  return {
    db: { select, insert, update },
    reset: () => {
      cursor = 0;
    },
  };
}

const baseInterview: GoalInterviewPayload = {
  archetype: "revenue",
  goalStatement: "Book 30 meetings/month with heads of platform",
  whyNow: "Enterprise launch in 45 days",
  horizonDays: 60,
  targetValue: 30,
  targetUnit: "meetings",
  baselineValue: 8,
  monthlyBudgetUsd: 1_200,
  constraints: ["no cold calls"],
  channels: ["email", "linkedin"],
  blockers: [],
  industry: "devtools",
  companySize: "11-50",
};

describe("agentPlansService.generatePlan", () => {
  beforeEach(async () => {
    const mod = await import("../agent-plans.js");
    mod.__clearAgentPlanCache();
  });

  it("returns a passing plan + rubric on the happy path", async () => {
    const { db } = makeDb({
      goal: {
        id: "goal-1",
        companyId: "co-1",
        title: "Grow pipeline",
        description: "outbound sales",
        level: "company",
      },
      company: {
        id: "co-1",
        name: "NorthStar",
        budgetMonthlyCents: 250_000,
        spentMonthlyCents: 15_000,
        metadata: { industry: "devtools", size: "11-50" },
      },
      connectors: [
        { provider: "hubspot", status: "connected" },
        { provider: "gmail", status: "connected" },
      ],
    });
    const { agentPlansService } = await import("../agent-plans.js");
    const svc = agentPlansService(db as unknown as Parameters<typeof agentPlansService>[0]);

    const result = await svc.generatePlan("co-1", "goal-1", baseInterview);
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.archetype).toBe("revenue");
    expect(result.plan.proposedAgents.length).toBeGreaterThan(0);
    expect(result.rubric.passesAPlus).toBe(true);
    expect(result.cached).toBe(false);
  });

  it("returns a structured error when goal is not in the company", async () => {
    const { db } = makeDb({ goal: null });
    const { agentPlansService } = await import("../agent-plans.js");
    const svc = agentPlansService(db as unknown as Parameters<typeof agentPlansService>[0]);
    const result = await svc.generatePlan("co-1", "missing", baseInterview);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/goal/i);
  });

  it("caches results per (goalId, interview-hash)", async () => {
    // The response queue is cycled so repeat calls still resolve; cache should
    // hit before the queue is consulted.
    const { db } = makeDb({
      goal: { id: "goal-1", companyId: "co-1", title: "Pipeline", description: "", level: "company" },
      company: {
        id: "co-1",
        name: "NorthStar",
        budgetMonthlyCents: 250_000,
        spentMonthlyCents: 15_000,
        metadata: {},
      },
    });
    const { agentPlansService } = await import("../agent-plans.js");
    const svc = agentPlansService(db as unknown as Parameters<typeof agentPlansService>[0]);

    const first = await svc.generatePlan("co-1", "goal-1", baseInterview);
    const second = await svc.generatePlan("co-1", "goal-1", baseInterview);
    expect("cached" in first && first.cached).toBe(false);
    expect("cached" in second && second.cached).toBe(true);
  });

  it("avoids duplicating roles already on the roster", async () => {
    const { db } = makeDb({
      goal: { id: "goal-1", companyId: "co-1", title: "Pipeline", description: "", level: "company" },
      company: {
        id: "co-1",
        name: "Ledgerly",
        budgetMonthlyCents: 500_000,
        spentMonthlyCents: 180_000,
        metadata: {},
      },
      connectors: [{ provider: "salesforce", status: "connected" }],
      existingAgents: [
        { id: "a1", role: "outbound_sdr", adapterType: "claude_api", adapterConfig: { skills: ["email_drafting", "crm_write"] } },
        { id: "a2", role: "account_researcher", adapterType: "claude_api", adapterConfig: { skills: ["web_research"] } },
      ],
    });
    const { agentPlansService } = await import("../agent-plans.js");
    const svc = agentPlansService(db as unknown as Parameters<typeof agentPlansService>[0]);

    const result = await svc.generatePlan("co-1", "goal-1", baseInterview);
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    const roles = result.plan.proposedAgents.map((a) => a.role);
    expect(roles).not.toContain("outbound_sdr");
    expect(roles).not.toContain("account_researcher");
  });
});
