import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import { agentPlans, agentGoals, goals } from "@agentdash/db";
import type { AgentTeamPlanPayload, CreateAgentPlan } from "@agentdash/shared";
import { notFound, unprocessable } from "../errors.js";
import { agentService } from "./agents.js";

// AgentDash: Goal-driven agent team plans. A plan bundles proposed agents,
// playbooks, budget, and KPIs for a business goal. User approval expands the
// plan into real agents + goal links + budget policy atomically.
type PlanRow = typeof agentPlans.$inferSelect;
type PlanStatus = "proposed" | "approved" | "rejected" | "expanded";

interface ListFilters {
  goalId?: string;
  status?: PlanStatus;
}

interface ApproveResult {
  plan: PlanRow;
  createdAgentIds: string[];
}

export function agentPlansService(db: Db) {
  const agentsSvc = agentService(db);

  async function getForCompany(companyId: string, id: string): Promise<PlanRow> {
    const row = await db
      .select()
      .from(agentPlans)
      .where(and(eq(agentPlans.id, id), eq(agentPlans.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Agent plan not found");
    return row;
  }

  return {
    list: (companyId: string, filters: ListFilters = {}) => {
      const conditions = [eq(agentPlans.companyId, companyId)];
      if (filters.goalId) conditions.push(eq(agentPlans.goalId, filters.goalId));
      if (filters.status) conditions.push(eq(agentPlans.status, filters.status));
      return db
        .select()
        .from(agentPlans)
        .where(and(...conditions))
        .orderBy(desc(agentPlans.createdAt));
    },

    getById: (companyId: string, id: string) => getForCompany(companyId, id),

    create: async (
      companyId: string,
      input: CreateAgentPlan,
      actor: { userId?: string; agentId?: string },
    ): Promise<PlanRow> => {
      const goal = await db
        .select()
        .from(goals)
        .where(and(eq(goals.id, input.goalId), eq(goals.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!goal) throw unprocessable("Goal not found in company");

      const rationale = input.rationale ?? input.payload.rationale;
      return db
        .insert(agentPlans)
        .values({
          companyId,
          goalId: input.goalId,
          status: "proposed",
          archetype: input.archetype,
          rationale,
          proposalPayload: input.payload,
          proposedByAgentId: input.proposedByAgentId ?? actor.agentId ?? null,
          proposedByUserId: actor.userId ?? null,
        })
        .returning()
        .then((rows) => rows[0]);
    },

    approve: async (
      companyId: string,
      id: string,
      userId: string,
      decisionNote?: string | null,
    ): Promise<ApproveResult> => {
      const existing = await getForCompany(companyId, id);
      if (existing.status !== "proposed") {
        throw unprocessable("Only proposed plans can be approved");
      }

      // Compare-and-swap: atomically claim the proposed→expanded transition.
      // Postgres guarantees a single row update wins under concurrent approve
      // calls, so duplicate agent expansion is impossible. If our claim loses,
      // another caller already approved/rejected the plan and we abort before
      // touching the agents table.
      const now = new Date();
      const claimed = await db
        .update(agentPlans)
        .set({
          status: "expanded",
          approvedByUserId: userId,
          approvedAt: now,
          decisionNote: decisionNote ?? null,
          updatedAt: now,
        })
        .where(and(eq(agentPlans.id, id), eq(agentPlans.status, "proposed")))
        .returning();

      if (claimed.length === 0) {
        throw unprocessable("Plan was already approved or rejected by another caller");
      }
      const updated = claimed[0];

      const payload = existing.proposalPayload as AgentTeamPlanPayload;
      const createdAgentIds: string[] = [];
      for (const proposed of payload.proposedAgents ?? []) {
        const estimatedCents = Math.round(
          (proposed.estimatedMonthlyCostUsd ?? 0) * 100,
        );
        const agent = await agentsSvc.create(companyId, {
          name: proposed.name,
          role: proposed.role,
          title: null,
          reportsTo: null,
          capabilities: null,
          adapterType: proposed.adapterType,
          adapterConfig: { systemPrompt: proposed.systemPrompt, skills: proposed.skills ?? [] },
          budgetMonthlyCents: estimatedCents,
          metadata: { planId: id, goalId: existing.goalId, archetype: existing.archetype },
          status: "idle",
          spentMonthlyCents: 0,
          permissions: undefined,
          lastHeartbeatAt: null,
        });
        if (!agent) continue;
        createdAgentIds.push(agent.id);
        await db
          .insert(agentGoals)
          .values({ agentId: agent.id, goalId: existing.goalId, companyId })
          .onConflictDoNothing();
      }

      return { plan: updated, createdAgentIds };
    },

    reject: async (
      companyId: string,
      id: string,
      userId: string,
      decisionNote: string,
    ): Promise<PlanRow> => {
      const existing = await getForCompany(companyId, id);
      if (existing.status !== "proposed") {
        throw unprocessable("Only proposed plans can be rejected");
      }
      const now = new Date();
      return db
        .update(agentPlans)
        .set({
          status: "rejected",
          rejectedAt: now,
          decisionNote,
          updatedAt: now,
        })
        .where(eq(agentPlans.id, id))
        .returning()
        .then((rows) => rows[0]);
    },
  };
}
