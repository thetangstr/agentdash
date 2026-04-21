// AgentDash: agent-plans service + validator tests.
// Validators are pure zod and exercised directly. Service create/approve/reject
// are shape-tested via minimal drizzle mocks (same pattern as action-proposals).

import { describe, it, expect, vi } from "vitest";
import {
  agentTeamPlanPayloadSchema,
  createAgentPlanSchema,
  approveAgentPlanSchema,
  rejectAgentPlanSchema,
  listAgentPlansQuerySchema,
} from "@agentdash/shared";

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

describe("agent-plans validators", () => {
  describe("agentTeamPlanPayloadSchema", () => {
    it("accepts a well-formed payload", () => {
      const parsed = agentTeamPlanPayloadSchema.parse(validPayload);
      expect(parsed.archetype).toBe("revenue");
      expect(parsed.proposedAgents).toHaveLength(1);
      expect(parsed.budget.monthlyCapUsd).toBe(500);
    });

    it("rejects a payload with zero agents", () => {
      const bad = { ...validPayload, proposedAgents: [] };
      expect(() => agentTeamPlanPayloadSchema.parse(bad)).toThrow();
    });

    it("rejects an unknown archetype", () => {
      const bad = { ...validPayload, archetype: "mystery" };
      expect(() => agentTeamPlanPayloadSchema.parse(bad)).toThrow();
    });

    it("rejects a budget with negative cap", () => {
      const bad = { ...validPayload, budget: { monthlyCapUsd: -1, killSwitchAtPct: 100, warnAtPct: 80 } };
      expect(() => agentTeamPlanPayloadSchema.parse(bad)).toThrow();
    });
  });

  describe("createAgentPlanSchema", () => {
    it("accepts a valid create payload", () => {
      const parsed = createAgentPlanSchema.parse({
        goalId: "00000000-0000-0000-0000-000000000001",
        archetype: "acquisition",
        payload: validPayload,
      });
      expect(parsed.archetype).toBe("acquisition");
    });

    it("rejects when goalId is not a uuid", () => {
      expect(() =>
        createAgentPlanSchema.parse({
          goalId: "not-a-uuid",
          archetype: "acquisition",
          payload: validPayload,
        }),
      ).toThrow();
    });
  });

  describe("approveAgentPlanSchema / rejectAgentPlanSchema", () => {
    it("accepts an approve without note", () => {
      expect(approveAgentPlanSchema.parse({})).toEqual({});
    });

    it("requires a decision note on reject", () => {
      expect(() => rejectAgentPlanSchema.parse({})).toThrow();
      expect(rejectAgentPlanSchema.parse({ decisionNote: "out of scope" })).toEqual({
        decisionNote: "out of scope",
      });
    });
  });

  describe("listAgentPlansQuerySchema", () => {
    it("parses optional filters", () => {
      const parsed = listAgentPlansQuerySchema.parse({
        goalId: "00000000-0000-0000-0000-000000000002",
        status: "proposed",
      });
      expect(parsed.status).toBe("proposed");
    });

    it("rejects an invalid status", () => {
      expect(() => listAgentPlansQuerySchema.parse({ status: "unknown" })).toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Service create/approve/reject — shape tests with minimal drizzle mocks
// ---------------------------------------------------------------------------

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

describe("agentPlansService", () => {
  it("list returns rows from db", async () => {
    const rows = [{ id: "plan-1", companyId: "co-1", goalId: "g-1", status: "proposed" }];
    const db = {
      select: vi.fn().mockReturnValue(thenable(rows)),
      insert: vi.fn().mockReturnValue(thenable([])),
      update: vi.fn().mockReturnValue(thenable([])),
    };
    const { agentPlansService } = await import("../agent-plans.js");
    const svc = agentPlansService(db as unknown as Parameters<typeof agentPlansService>[0]);
    const result = await svc.list("co-1");
    expect(result).toEqual(rows);
  });

  it("create inserts after resolving the goal", async () => {
    const goal = { id: "g-1", companyId: "co-1", title: "Unassigned" };
    const planRow = {
      id: "plan-new",
      companyId: "co-1",
      goalId: "g-1",
      status: "proposed",
      archetype: "revenue",
    };
    const selectImpl = vi.fn().mockReturnValueOnce(thenable([goal]));
    const insertImpl = vi.fn().mockReturnValueOnce(thenable([planRow]));
    const db = {
      select: selectImpl,
      insert: insertImpl,
      update: vi.fn().mockReturnValue(thenable([])),
    };
    const { agentPlansService } = await import("../agent-plans.js");
    const svc = agentPlansService(db as unknown as Parameters<typeof agentPlansService>[0]);
    const created = await svc.create(
      "co-1",
      {
        goalId: "g-1",
        archetype: "revenue",
        payload: validPayload,
      },
      { userId: "user-1" },
    );
    expect(created.id).toBe("plan-new");
    expect(insertImpl).toHaveBeenCalled();
  });

  it("reject throws when plan is already approved", async () => {
    const existing = { id: "plan-1", companyId: "co-1", goalId: "g-1", status: "expanded" };
    const db = {
      select: vi.fn().mockReturnValue(thenable([existing])),
      insert: vi.fn().mockReturnValue(thenable([])),
      update: vi.fn().mockReturnValue(thenable([])),
    };
    const { agentPlansService } = await import("../agent-plans.js");
    const svc = agentPlansService(db as unknown as Parameters<typeof agentPlansService>[0]);
    await expect(svc.reject("co-1", "plan-1", "user-1", "nope")).rejects.toThrow();
  });
});
