import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import {
  agentPlans,
  agentGoals,
  agents,
  companies,
  companyConnectors,
  goals,
} from "@agentdash/db";
import {
  agentTeamPlanPayloadSchema,
  type AgentTeamPlanPayload,
  type CreateAgentPlan,
  type GoalInterviewPayload,
  type UpdateAgentPlanProposal,
} from "@agentdash/shared";
import { notFound, unprocessable } from "../errors.js";
import { agentService } from "./agents.js";
import {
  type CompanyContextBundle,
  type ExistingAgentSummary,
  type PriorPlanOutcome,
  generateDynamicPlan,
  hashInterview,
} from "./agent-plans-generator.js";
import { scorePlan, type RubricResult } from "./agent-plans-rubric.js";

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

// AgentDash: result of `generatePlan`. Either a validated, rubric-passing
// payload, or a structured error describing which rubric dimension failed.
// NOTE: callers must handle both branches; the generator intentionally refuses
// to surface plans that fail the A+ bar (any rubric dim < 6/10). See AGE-41.
export interface GeneratePlanSuccess {
  plan: AgentTeamPlanPayload;
  archetype: string;
  interviewHash: string;
  rubric: RubricResult;
  cached: boolean;
}

export interface GeneratePlanError {
  error: string;
  rubric?: RubricResult;
}

export type GeneratePlanResult = GeneratePlanSuccess | GeneratePlanError;

// In-process LRU cache keyed on (goalId, interview-hash). See AGE-41 criterion:
// "LLM call cached per (goalId, interviewPayload-hash)". Even though our
// default generator is deterministic + cheap, the cache preserves stability
// for clients that read the plan back repeatedly, and is the seam for an
// optional LLM rewrite pass.
const PLAN_CACHE = new Map<string, GeneratePlanSuccess>();
const PLAN_CACHE_MAX = 256;

function cacheKey(companyId: string, goalId: string, hash: string): string {
  return `${companyId}::${goalId}::${hash}`;
}

function cacheSet(key: string, value: GeneratePlanSuccess): void {
  // Simple FIFO eviction so memory usage is bounded.
  if (PLAN_CACHE.size >= PLAN_CACHE_MAX) {
    const firstKey = PLAN_CACHE.keys().next().value;
    if (firstKey !== undefined) PLAN_CACHE.delete(firstKey);
  }
  PLAN_CACHE.set(key, value);
}

// Exposed so tests can reset between cases.
export function __clearAgentPlanCache(): void {
  PLAN_CACHE.clear();
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

    // AgentDash (AGE-48 Phase 2): merge editor-drawer mutations into a
    // proposed plan's payload. Only valid while the plan is still in
    // `status='proposed'` — after approve/reject the payload is frozen.
    // The caller threads an activity-log entry (`plan.edited`) at the route
    // layer so this function stays focused on the db mutation itself.
    updateProposal: async (
      companyId: string,
      id: string,
      patch: UpdateAgentPlanProposal,
    ): Promise<PlanRow> => {
      const existing = await getForCompany(companyId, id);
      if (existing.status !== "proposed") {
        throw unprocessable("Only proposed plans can be edited");
      }
      const current = existing.proposalPayload as AgentTeamPlanPayload;
      // Whitelist-merge so we only touch fields the schema allows and keep
      // the rest of the payload (archetype, …) intact.
      const nextPayload: AgentTeamPlanPayload = {
        ...current,
        ...(patch.rationale !== undefined ? { rationale: patch.rationale } : {}),
        ...(patch.proposedAgents !== undefined ? { proposedAgents: patch.proposedAgents } : {}),
        ...(patch.proposedPlaybooks !== undefined
          ? { proposedPlaybooks: patch.proposedPlaybooks }
          : {}),
        ...(patch.budget !== undefined ? { budget: patch.budget } : {}),
        ...(patch.kpis !== undefined ? { kpis: patch.kpis } : {}),
      };
      // Validate the merged result — prevents partial edits from producing an
      // invalid payload (e.g., empty proposedAgents).
      const parsed = agentTeamPlanPayloadSchema.safeParse(nextPayload);
      if (!parsed.success) {
        throw unprocessable(`Merged plan payload is invalid: ${parsed.error.message}`);
      }
      const now = new Date();
      return db
        .update(agentPlans)
        .set({
          proposalPayload: parsed.data,
          rationale: parsed.data.rationale,
          ...(patch.decisionNote !== undefined ? { decisionNote: patch.decisionNote } : {}),
          updatedAt: now,
        })
        .where(and(eq(agentPlans.id, id), eq(agentPlans.status, "proposed")))
        .returning()
        .then((rows) => {
          if (rows.length === 0) {
            throw unprocessable("Plan was approved or rejected before the edit landed");
          }
          return rows[0];
        });
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

    // AgentDash (AGE-41): Chief of Staff dynamic plan generation.
    // Pulls company context, runs the dynamic generator, scores the output
    // against the rubric, and returns either a passing plan or a structured
    // error. Results are cached per (goalId, interview-hash).
    generatePlan: async (
      companyId: string,
      goalId: string,
      interviewPayload: GoalInterviewPayload,
    ): Promise<GeneratePlanResult> => {
      // 1. Resolve goal (company-scoped).
      const goal = await db
        .select()
        .from(goals)
        .where(and(eq(goals.id, goalId), eq(goals.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!goal) return { error: "Goal not found in company" };

      // 2. Build the context bundle. Each read is independent → run in parallel.
      const [companyRow, connectorsRows, existingAgentsRows, priorPlansRows] =
        await Promise.all([
          db
            .select()
            .from(companies)
            .where(eq(companies.id, companyId))
            .then((rows) => rows[0] ?? null),
          db
            .select()
            .from(companyConnectors)
            .where(eq(companyConnectors.companyId, companyId)),
          db
            .select()
            .from(agents)
            .where(eq(agents.companyId, companyId)),
          db
            .select()
            .from(agentPlans)
            .where(eq(agentPlans.companyId, companyId))
            .orderBy(desc(agentPlans.createdAt)),
        ]);

      if (!companyRow) return { error: "Company not found" };

      const metadata = (companyRow.metadata ?? {}) as Record<string, unknown>;
      const industry = typeof metadata.industry === "string" ? metadata.industry : undefined;
      const companySize = typeof metadata.size === "string" ? metadata.size : undefined;

      const connectors = (connectorsRows as Array<{ provider: string; status: string }>)
        .filter((c) => c.status === "connected")
        .map((c) => c.provider);

      const existingAgents: ExistingAgentSummary[] = (existingAgentsRows as Array<{
        id: string;
        role: string;
        adapterType: string;
        adapterConfig: Record<string, unknown> | null;
      }>).map((a) => {
        const cfg = a.adapterConfig ?? {};
        const skills = Array.isArray((cfg as Record<string, unknown>).skills)
          ? ((cfg as Record<string, unknown>).skills as unknown[]).filter(
              (s): s is string => typeof s === "string",
            )
          : [];
        return { id: a.id, role: a.role, adapterType: a.adapterType, skills };
      });

      const priorOutcomes: PriorPlanOutcome[] = (priorPlansRows as PlanRow[]).map((p) => ({
        planId: p.id,
        archetype: p.archetype as PriorPlanOutcome["archetype"],
        status: p.status as PriorPlanOutcome["status"],
        decisionNote: p.decisionNote,
      }));

      const budgetMonthlyUsd = Math.round((companyRow.budgetMonthlyCents ?? 0) / 100);
      const spentMonthlyUsd = Math.round((companyRow.spentMonthlyCents ?? 0) / 100);

      const context: CompanyContextBundle = {
        companyId,
        companyName: companyRow.name,
        industry,
        companySize,
        goal: {
          id: goal.id,
          title: goal.title,
          description: goal.description,
          level: goal.level,
        },
        connectors,
        existingAgents,
        budget: {
          monthlyCapUsd: budgetMonthlyUsd,
          spentMonthToDateUsd: spentMonthlyUsd,
        },
        priorOutcomes,
      };

      // 3. Cache key is stable across runs for the same interview shape.
      const interviewHash = hashInterview(goalId, interviewPayload);
      const key = cacheKey(companyId, goalId, interviewHash);
      const cached = PLAN_CACHE.get(key);
      if (cached) return { ...cached, cached: true };

      // 4. Generate.
      const generated = generateDynamicPlan(context, interviewPayload);

      // 5. Validate the payload against the zod contract. If the generator
      // produces something that doesn't pass the contract, that's an
      // internal bug — surface it clearly.
      const parsed = agentTeamPlanPayloadSchema.safeParse(generated.payload);
      if (!parsed.success) {
        return { error: `Generator produced invalid payload: ${parsed.error.message}` };
      }

      // 6. Score the plan against the A+ rubric.
      const rubric = scorePlan(parsed.data, context);
      if (rubric.hardFailure) {
        return {
          error: `Plan failed rubric hard-floor (min=${rubric.minimum.toFixed(1)}/10)`,
          rubric,
        };
      }

      const success: GeneratePlanSuccess = {
        plan: parsed.data,
        archetype: generated.archetype,
        interviewHash,
        rubric,
        cached: false,
      };
      cacheSet(key, success);
      return success;
    },
  };
}
