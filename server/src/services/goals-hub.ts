import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import {
  activityLog,
  agentGoals,
  agentPipelines,
  agentPlans,
  agents,
  budgetPolicies,
  costEvents,
  financeEvents,
  goals,
  heartbeatRuns,
  issues,
  routines,
} from "@agentdash/db";
import type { AgentTeamPlanPayload, ProposedKpi } from "@agentdash/shared";
import { notFound } from "../errors.js";

// AgentDash: Goal hub rollup. Single round-trip that backs the Goal detail page.
// Aggregates agent roster, originating plan, open work, spend/revenue vs budget,
// KPI progress, and a combined activity timeline for a business goal.
//
// All reads are scoped by (companyId, goalId). Indexes added in AGE-30 cover the
// join predicates so this endpoint stays cheap on large companies.

export interface GoalHubAgentSummary {
  agentId: string;
  name: string;
  role: string;
  status: string;
  adapterType: string;
  budgetMonthlyCents: number;
  spendMonthlyCents: number;
  linkedAt: string;
}

export interface GoalHubPlanSummary {
  id: string;
  archetype: string;
  status: string;
  rationale: string | null;
  decisionNote: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  proposedByUserId: string | null;
  approvedByUserId: string | null;
  createdAt: string;
}

export interface GoalHubWorkSummary {
  openIssueCount: number;
  issuesByStatus: Record<string, number>;
  activeRoutineCount: number;
  routinesByStatus: Record<string, number>;
  activePipelineCount: number;
  pipelinesByStatus: Record<string, number>;
}

// AgentDash (AGE-42): Playbooks listing for the goal hub. Playbooks are the
// user-facing name for pipelines now that Pipelines is no longer a top-level
// nav item — they roll up under the business Goal they serve.
export interface GoalHubPlaybookRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  executionMode: string;
  stageCount: number;
  updatedAt: string;
}

export interface GoalHubSpendSummary {
  windowStart: string;
  windowEnd: string;
  spendCents: number;
  revenueCents: number;
  netCents: number;
  budgetCents: number | null;
  budgetPolicyId: string | null;
  percentOfBudget: number | null;
}

export interface GoalHubKpiRow {
  metric: string;
  baseline: number;
  target: number;
  current: number;
  unit: string;
  horizonDays: number;
  deltaToTarget: number;
  progressPercent: number;
  onTrack: boolean;
}

export interface GoalHubActivityEntry {
  id: string;
  kind: "activity_log" | "heartbeat_run";
  occurredAt: string;
  summary: string;
  actorType?: string;
  actorId?: string;
  agentId?: string | null;
  entityType?: string;
  entityId?: string;
  status?: string;
}

export interface GoalHubRollup {
  goal: typeof goals.$inferSelect;
  plan: GoalHubPlanSummary | null;
  agents: GoalHubAgentSummary[];
  work: GoalHubWorkSummary;
  spend: GoalHubSpendSummary;
  kpis: GoalHubKpiRow[];
  // AgentDash (AGE-42): Playbooks (pipelines) linked to this goal.
  playbooks: GoalHubPlaybookRow[];
  activity: GoalHubActivityEntry[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function startOfCurrentMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

function endOfCurrentMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
}

function coerceNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function toIso(value: Date | string | null | undefined): string {
  if (!value) return new Date(0).toISOString();
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function extractKpis(payload: unknown): ProposedKpi[] {
  if (!payload || typeof payload !== "object") return [];
  const maybe = (payload as { kpis?: unknown }).kpis;
  if (!Array.isArray(maybe)) return [];
  return maybe.filter((k): k is ProposedKpi => {
    return (
      !!k && typeof k === "object" &&
      typeof (k as ProposedKpi).metric === "string" &&
      typeof (k as ProposedKpi).baseline === "number" &&
      typeof (k as ProposedKpi).target === "number"
    );
  });
}

/**
 * Compute KPI progress vs target.
 * - progressPercent = (current - baseline) / (target - baseline) * 100
 *   clamped to [0, 200]. Direction-agnostic: if target < baseline (cost-down
 *   goal), we flip the sign so reduction still registers as progress.
 * - onTrack: progressPercent >= expected linear pace. For MVP we use 50%
 *   (i.e. we're on-track if we're at least halfway to target). Horizon-based
 *   pacing (elapsed/horizonDays) can come in a follow-up once the plan carries
 *   a createdAt/window anchor — defaulting to 50% keeps the UI meaningful.
 */
export function computeKpiProgress(
  kpi: ProposedKpi,
  current: number,
): Pick<GoalHubKpiRow, "deltaToTarget" | "progressPercent" | "onTrack"> {
  const span = kpi.target - kpi.baseline;
  if (span === 0) {
    const onTrack = current >= kpi.target;
    return { deltaToTarget: kpi.target - current, progressPercent: onTrack ? 100 : 0, onTrack };
  }
  const raw = ((current - kpi.baseline) / span) * 100;
  const progressPercent = Math.max(0, Math.min(200, Number.isFinite(raw) ? raw : 0));
  const deltaToTarget = kpi.target - current;
  const onTrack = progressPercent >= 50;
  return {
    deltaToTarget,
    progressPercent: Math.round(progressPercent * 100) / 100,
    onTrack,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export function goalsHubService(db: Db) {
  async function assertGoalInCompany(companyId: string, goalId: string) {
    const goal = await db
      .select()
      .from(goals)
      .where(and(eq(goals.id, goalId), eq(goals.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!goal) throw notFound("Goal not found in company");
    return goal;
  }

  async function loadRoster(companyId: string, goalId: string): Promise<GoalHubAgentSummary[]> {
    const rows = await db
      .select({
        agentId: agents.id,
        name: agents.name,
        role: agents.role,
        status: agents.status,
        adapterType: agents.adapterType,
        budgetMonthlyCents: agents.budgetMonthlyCents,
        spendMonthlyCents: agents.spentMonthlyCents,
        linkedAt: agentGoals.createdAt,
      })
      .from(agentGoals)
      .innerJoin(agents, eq(agents.id, agentGoals.agentId))
      .where(and(eq(agentGoals.companyId, companyId), eq(agentGoals.goalId, goalId)));

    return rows.map((r) => ({
      agentId: r.agentId as string,
      name: r.name as string,
      role: r.role as string,
      status: r.status as string,
      adapterType: r.adapterType as string,
      budgetMonthlyCents: coerceNumber(r.budgetMonthlyCents),
      spendMonthlyCents: coerceNumber(r.spendMonthlyCents),
      linkedAt: toIso(r.linkedAt as Date | string),
    }));
  }

  async function loadOriginatingPlan(
    companyId: string,
    goalId: string,
  ): Promise<{ row: typeof agentPlans.$inferSelect | null; summary: GoalHubPlanSummary | null }> {
    // Prefer the most-recently-expanded plan (that's what spawned the agents);
    // fall back to the most recent proposed/rejected plan so the card still
    // tells the user what was considered.
    const rows = await db
      .select()
      .from(agentPlans)
      .where(and(eq(agentPlans.companyId, companyId), eq(agentPlans.goalId, goalId)));

    if (rows.length === 0) return { row: null, summary: null };

    const priority: Record<string, number> = {
      expanded: 4,
      approved: 3,
      proposed: 2,
      rejected: 1,
    };
    const sorted = [...rows].sort((a, b) => {
      const pa = priority[a.status as string] ?? 0;
      const pb = priority[b.status as string] ?? 0;
      if (pa !== pb) return pb - pa;
      const da = new Date(a.createdAt as Date).getTime();
      const dc = new Date(b.createdAt as Date).getTime();
      return dc - da;
    });
    const chosen = sorted[0];

    return {
      row: chosen,
      summary: {
        id: chosen.id as string,
        archetype: chosen.archetype as string,
        status: chosen.status as string,
        rationale: (chosen.rationale as string | null) ?? null,
        decisionNote: (chosen.decisionNote as string | null) ?? null,
        approvedAt: chosen.approvedAt ? toIso(chosen.approvedAt as Date) : null,
        rejectedAt: chosen.rejectedAt ? toIso(chosen.rejectedAt as Date) : null,
        proposedByUserId: (chosen.proposedByUserId as string | null) ?? null,
        approvedByUserId: (chosen.approvedByUserId as string | null) ?? null,
        createdAt: toIso(chosen.createdAt as Date),
      },
    };
  }

  async function loadWork(companyId: string, goalId: string): Promise<GoalHubWorkSummary> {
    const [issueRows, routineRows, pipelineRows] = await Promise.all([
      db
        .select({ status: issues.status, count: sql<number>`count(*)::int` })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.goalId, goalId)))
        .groupBy(issues.status),
      db
        .select({ status: routines.status, count: sql<number>`count(*)::int` })
        .from(routines)
        .where(and(eq(routines.companyId, companyId), eq(routines.goalId, goalId)))
        .groupBy(routines.status),
      db
        .select({ status: agentPipelines.status, count: sql<number>`count(*)::int` })
        .from(agentPipelines)
        .where(and(eq(agentPipelines.companyId, companyId), eq(agentPipelines.goalId, goalId)))
        .groupBy(agentPipelines.status),
    ]);

    const OPEN_ISSUE = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);
    const ACTIVE_ROUTINE = new Set(["active"]);
    const ACTIVE_PIPELINE = new Set(["active", "draft"]);

    const issuesByStatus: Record<string, number> = {};
    let openIssueCount = 0;
    for (const row of issueRows) {
      const status = String(row.status ?? "unknown");
      const count = coerceNumber(row.count);
      issuesByStatus[status] = (issuesByStatus[status] ?? 0) + count;
      if (OPEN_ISSUE.has(status)) openIssueCount += count;
    }

    const routinesByStatus: Record<string, number> = {};
    let activeRoutineCount = 0;
    for (const row of routineRows) {
      const status = String(row.status ?? "unknown");
      const count = coerceNumber(row.count);
      routinesByStatus[status] = (routinesByStatus[status] ?? 0) + count;
      if (ACTIVE_ROUTINE.has(status)) activeRoutineCount += count;
    }

    const pipelinesByStatus: Record<string, number> = {};
    let activePipelineCount = 0;
    for (const row of pipelineRows) {
      const status = String(row.status ?? "unknown");
      const count = coerceNumber(row.count);
      pipelinesByStatus[status] = (pipelinesByStatus[status] ?? 0) + count;
      if (ACTIVE_PIPELINE.has(status)) activePipelineCount += count;
    }

    return {
      openIssueCount,
      issuesByStatus,
      activeRoutineCount,
      routinesByStatus,
      activePipelineCount,
      pipelinesByStatus,
    };
  }

  // AgentDash (AGE-42): Playbook list for the Goal hub "Playbooks" card.
  async function loadPlaybooks(
    companyId: string,
    goalId: string,
  ): Promise<GoalHubPlaybookRow[]> {
    const rows = await db
      .select()
      .from(agentPipelines)
      .where(
        and(eq(agentPipelines.companyId, companyId), eq(agentPipelines.goalId, goalId)),
      );
    return rows
      .map((r) => ({
        id: r.id as string,
        name: r.name as string,
        description: (r.description as string | null) ?? null,
        status: r.status as string,
        executionMode: r.executionMode as string,
        stageCount: Array.isArray(r.stages) ? (r.stages as unknown[]).length : 0,
        updatedAt: toIso(r.updatedAt as Date),
      }))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }

  async function loadSpend(
    companyId: string,
    goalId: string,
    now: Date,
  ): Promise<GoalHubSpendSummary> {
    const windowStart = startOfCurrentMonth(now);
    const windowEnd = endOfCurrentMonth(now);

    const [costRows, revenueRows, budgetRow] = await Promise.all([
      db
        .select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            eq(costEvents.goalId, goalId),
            gte(costEvents.occurredAt, windowStart),
          ),
        ),
      db
        .select({
          total: sql<number>`coalesce(sum(case when ${financeEvents.direction} = 'credit' then ${financeEvents.amountCents} else 0 end), 0)::int`,
        })
        .from(financeEvents)
        .where(
          and(
            eq(financeEvents.companyId, companyId),
            eq(financeEvents.goalId, goalId),
            gte(financeEvents.occurredAt, windowStart),
          ),
        ),
      db
        .select()
        .from(budgetPolicies)
        .where(
          and(
            eq(budgetPolicies.companyId, companyId),
            eq(budgetPolicies.goalId, goalId),
            eq(budgetPolicies.isActive, true),
          ),
        )
        .then((rows) => rows[0] ?? null),
    ]);

    const spendCents = coerceNumber(costRows[0]?.total ?? 0);
    const revenueCents = coerceNumber(revenueRows[0]?.total ?? 0);
    const budgetCents =
      budgetRow && typeof budgetRow.amount === "number" ? budgetRow.amount : null;
    const percentOfBudget =
      budgetCents && budgetCents > 0
        ? Math.round((spendCents / budgetCents) * 10000) / 100
        : null;

    return {
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      spendCents,
      revenueCents,
      netCents: revenueCents - spendCents,
      budgetCents,
      budgetPolicyId: (budgetRow?.id as string | undefined) ?? null,
      percentOfBudget,
    };
  }

  async function loadKpis(
    planRow: typeof agentPlans.$inferSelect | null,
    spend: GoalHubSpendSummary,
  ): Promise<GoalHubKpiRow[]> {
    if (!planRow) return [];
    const kpis = extractKpis(planRow.proposalPayload as AgentTeamPlanPayload);

    return kpis.map((kpi) => {
      // Best-effort "current" readout. Without a time-series store, we can
      // fill a few well-known metrics from the spend rollup; everything else
      // starts at baseline so the UI shows baseline → target with a zero delta.
      let current = kpi.baseline;
      const metricKey = kpi.metric.toLowerCase();
      if (metricKey === "monthly_spend_cents" || metricKey === "spend_cents") {
        current = spend.spendCents;
      } else if (metricKey === "monthly_revenue_cents" || metricKey === "revenue_cents") {
        current = spend.revenueCents;
      } else if (metricKey === "net_cents" || metricKey === "net_monthly_cents") {
        current = spend.netCents;
      }
      const progress = computeKpiProgress(kpi, current);
      return {
        metric: kpi.metric,
        baseline: kpi.baseline,
        target: kpi.target,
        current,
        unit: kpi.unit,
        horizonDays: kpi.horizonDays,
        ...progress,
      };
    });
  }

  async function loadActivity(
    companyId: string,
    goalId: string,
    agentIds: string[],
    limit: number,
  ): Promise<GoalHubActivityEntry[]> {
    // Issue ids for this goal — used to rollup heartbeat_runs + activity_log.
    const issueRows = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.goalId, goalId)));
    const issueIds = issueRows.map((r) => r.id as string);

    const activityPromise = db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          sql`(
            (${activityLog.entityType} = 'goal' and ${activityLog.entityId} = ${goalId})
            ${issueIds.length > 0
              ? sql`or (${activityLog.entityType} = 'issue' and ${activityLog.entityId} in (${sql.join(issueIds.map((id) => sql`${id}`), sql`, `)}))`
              : sql``}
          )`,
        ),
      )
      .orderBy(sql`${activityLog.createdAt} desc`)
      .limit(limit);

    const heartbeatPromise =
      issueIds.length > 0 || agentIds.length > 0
        ? db
            .select()
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.companyId, companyId),
                issueIds.length > 0 && agentIds.length > 0
                  ? sql`(${heartbeatRuns.issueId} in (${sql.join(issueIds.map((id) => sql`${id}`), sql`, `)}) or ${heartbeatRuns.agentId} in (${sql.join(agentIds.map((id) => sql`${id}`), sql`, `)}))`
                  : issueIds.length > 0
                  ? inArray(heartbeatRuns.issueId, issueIds)
                  : inArray(heartbeatRuns.agentId, agentIds),
              ),
            )
            .orderBy(sql`${heartbeatRuns.createdAt} desc`)
            .limit(limit)
        : Promise.resolve([] as (typeof heartbeatRuns.$inferSelect)[]);

    const [activityRows, runRows] = await Promise.all([activityPromise, heartbeatPromise]);

    const entries: GoalHubActivityEntry[] = [];
    for (const row of activityRows) {
      entries.push({
        id: row.id as string,
        kind: "activity_log",
        occurredAt: toIso(row.createdAt as Date),
        summary: `${row.action as string}`,
        actorType: row.actorType as string,
        actorId: row.actorId as string,
        agentId: (row.agentId as string | null) ?? null,
        entityType: row.entityType as string,
        entityId: row.entityId as string,
      });
    }
    for (const row of runRows) {
      entries.push({
        id: row.id as string,
        kind: "heartbeat_run",
        occurredAt: toIso((row.startedAt as Date | null) ?? (row.createdAt as Date)),
        summary: `heartbeat ${row.status as string}`,
        agentId: (row.agentId as string | null) ?? null,
        entityType: row.issueId ? "issue" : "agent",
        entityId: (row.issueId as string | null) ?? (row.agentId as string),
        status: row.status as string,
      });
    }

    entries.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0));
    return entries.slice(0, limit);
  }

  return {
    getRollup: async (
      companyId: string,
      goalId: string,
      options: { now?: Date; activityLimit?: number } = {},
    ): Promise<GoalHubRollup> => {
      const goal = await assertGoalInCompany(companyId, goalId);
      const now = options.now ?? new Date();
      const activityLimit = options.activityLimit ?? 25;

      const [roster, planResult, work, spend, playbooks] = await Promise.all([
        loadRoster(companyId, goalId),
        loadOriginatingPlan(companyId, goalId),
        loadWork(companyId, goalId),
        loadSpend(companyId, goalId, now),
        loadPlaybooks(companyId, goalId),
      ]);

      const kpis = await loadKpis(planResult.row, spend);
      const activity = await loadActivity(
        companyId,
        goalId,
        roster.map((r) => r.agentId),
        activityLimit,
      );

      return {
        goal,
        plan: planResult.summary,
        agents: roster,
        work,
        spend,
        kpis,
        playbooks,
        activity,
      };
    },
  };
}
