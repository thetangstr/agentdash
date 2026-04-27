import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import {
  budgetAllocations,
  budgetPolicies,
  costEvents,
  departments,
  resourceUsageEvents,
  issues,
} from "@agentdash/db";
import { notFound, unprocessable } from "../errors.js";

export function budgetForecastService(db: Db) {
  return {
    /**
     * Compute burn rate for a given scope (agent or project).
     * Compares last-7-day average to prior-7-day average for trend,
     * and projects days until the budget policy is exhausted.
     */
    computeBurnRate: async (
      companyId: string,
      scopeType: "agent" | "project",
      scopeId: string,
    ) => {
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

      const scopeCondition =
        scopeType === "agent"
          ? eq(costEvents.agentId, scopeId)
          : eq(costEvents.projectId, scopeId);

      // Total spend over last 30 days
      const [thirtyDayRow] = await db
        .select({
          total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            scopeCondition,
            gte(costEvents.occurredAt, thirtyDaysAgo),
            lte(costEvents.occurredAt, now),
          ),
        );

      // Total spend over last 7 days
      const [lastSevenRow] = await db
        .select({
          total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            scopeCondition,
            gte(costEvents.occurredAt, sevenDaysAgo),
            lte(costEvents.occurredAt, now),
          ),
        );

      // Total spend over prior 7 days (day 14 to day 7)
      const [priorSevenRow] = await db
        .select({
          total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            scopeCondition,
            gte(costEvents.occurredAt, fourteenDaysAgo),
            lte(costEvents.occurredAt, sevenDaysAgo),
          ),
        );

      const thirtyDayTotal = Number(thirtyDayRow?.total ?? 0);
      const lastSevenTotal = Number(lastSevenRow?.total ?? 0);
      const priorSevenTotal = Number(priorSevenRow?.total ?? 0);

      const dailyAvgCents = Math.round(thirtyDayTotal / 30);
      const lastSevenDailyAvg = lastSevenTotal / 7;
      const priorSevenDailyAvg = priorSevenTotal / 7;

      const weeklyTrendPercent =
        priorSevenDailyAvg > 0
          ? Math.round(((lastSevenDailyAvg - priorSevenDailyAvg) / priorSevenDailyAvg) * 100)
          : 0;

      // Look up the budget policy for this scope to compute remaining budget
      const [policy] = await db
        .select()
        .from(budgetPolicies)
        .where(
          and(
            eq(budgetPolicies.companyId, companyId),
            eq(budgetPolicies.scopeType, scopeType),
            eq(budgetPolicies.scopeId, scopeId),
            eq(budgetPolicies.isActive, true),
          ),
        );

      let daysUntilExhausted: number | null = null;
      if (policy && dailyAvgCents > 0) {
        // Calculate total observed spend within the policy window
        const [observedRow] = await db
          .select({
            total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
          })
          .from(costEvents)
          .where(
            and(
              eq(costEvents.companyId, companyId),
              scopeCondition,
            ),
          );
        const observedTotal = Number(observedRow?.total ?? 0);
        const remaining = Math.max(0, policy.amount - observedTotal);
        daysUntilExhausted = Math.floor(remaining / dailyAvgCents);
      }

      const projectedMonthEndCents = dailyAvgCents * 30;

      return {
        dailyAvgCents,
        weeklyTrendPercent,
        daysUntilExhausted,
        projectedMonthEndCents,
      };
    },

    /**
     * Compute a company-wide burn rate aggregate (no scope filter).
     * Returns the same shape as computeBurnRate so the UI can treat it uniformly.
     * Used when the client passes scopeType=company to the burn-rate endpoint.
     */
    computeCompanyBurnRate: async (companyId: string) => {
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

      const [thirtyDayRow] = await db
        .select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
        .from(costEvents)
        .where(and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, thirtyDaysAgo), lte(costEvents.occurredAt, now)));

      const [lastSevenRow] = await db
        .select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
        .from(costEvents)
        .where(and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, sevenDaysAgo), lte(costEvents.occurredAt, now)));

      const [priorSevenRow] = await db
        .select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
        .from(costEvents)
        .where(and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, fourteenDaysAgo), lte(costEvents.occurredAt, sevenDaysAgo)));

      const thirtyDayTotal = Number(thirtyDayRow?.total ?? 0);
      const lastSevenTotal = Number(lastSevenRow?.total ?? 0);
      const priorSevenTotal = Number(priorSevenRow?.total ?? 0);

      const dailyAvgCents = Math.round(thirtyDayTotal / 30);
      const lastSevenDailyAvg = lastSevenTotal / 7;
      const priorSevenDailyAvg = priorSevenTotal / 7;
      const weeklyTrendPercent =
        priorSevenDailyAvg > 0
          ? Math.round(((lastSevenDailyAvg - priorSevenDailyAvg) / priorSevenDailyAvg) * 100)
          : 0;

      const projectedMonthEndCents = dailyAvgCents * 30;

      // UI expects these field names (BurnRateData interface in BudgetForecast.tsx)
      return {
        scopeType: "company",
        scopeId: companyId,
        dailyBurn: Math.round(dailyAvgCents / 100),
        weeklyBurn: Math.round(lastSevenTotal / 100),
        monthlyBurn: Math.round(thirtyDayTotal / 100),
        projectedMonthlyTotal: Math.round(projectedMonthEndCents / 100),
        daysUntilBudgetExhausted: null,
        weeklyTrendPercent,
        // legacy fields kept for backwards-compat with other callers
        dailyAvgCents,
        weeklyTrendPercentLegacy: weeklyTrendPercent,
        daysUntilExhausted: null,
        projectedMonthEndCents,
      };
    },

    /**
     * Compute a simple ROI metric for a project: total cost vs issues completed.
     */
    computeProjectROI: async (companyId: string, projectId: string) => {
      const [costRow] = await db
        .select({
          total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            eq(costEvents.projectId, projectId),
          ),
        );

      const [issueRow] = await db
        .select({
          count: sql<number>`count(*)::int`,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.projectId, projectId),
            eq(issues.status, "done"),
          ),
        );

      const totalCostCents = Number(costRow?.total ?? 0);
      const issuesCompleted = Number(issueRow?.count ?? 0);
      const costPerIssueCents = issuesCompleted > 0 ? Math.round(totalCostCents / issuesCompleted) : 0;

      return {
        totalCostCents,
        issuesCompleted,
        costPerIssueCents,
      };
    },

    /**
     * List all departments for a company.
     */
    listDepartments: async (companyId: string) => {
      return db
        .select()
        .from(departments)
        .where(eq(departments.companyId, companyId));
    },

    /**
     * Create a new department.
     */
    createDepartment: async (
      companyId: string,
      data: {
        name: string;
        description?: string;
        parentId?: string;
        leadUserId?: string;
      },
    ) => {
      const [row] = await db
        .insert(departments)
        .values({
          companyId,
          name: data.name,
          description: data.description ?? null,
          parentId: data.parentId ?? null,
          leadUserId: data.leadUserId ?? null,
        })
        .returning();

      return row;
    },

    /**
     * Partial update of a department. Throws notFound if the department does not exist.
     */
    updateDepartment: async (
      id: string,
      data: {
        name?: string;
        description?: string;
        parentId?: string;
        leadUserId?: string;
      },
    ) => {
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (data.name !== undefined) updates.name = data.name;
      if (data.description !== undefined) updates.description = data.description;
      if (data.parentId !== undefined) updates.parentId = data.parentId;
      if (data.leadUserId !== undefined) updates.leadUserId = data.leadUserId;

      const [row] = await db
        .update(departments)
        .set(updates)
        .where(eq(departments.id, id))
        .returning();

      if (!row) throw notFound("Department not found");
      return row;
    },

    /**
     * Create a budget allocation linking a parent policy to a child policy.
     */
    createAllocation: async (
      companyId: string,
      data: {
        parentPolicyId: string;
        childPolicyId: string;
        allocatedAmount: number;
        isFlexible?: boolean;
      },
    ) => {
      const [row] = await db
        .insert(budgetAllocations)
        .values({
          companyId,
          parentPolicyId: data.parentPolicyId,
          childPolicyId: data.childPolicyId,
          allocatedAmount: data.allocatedAmount,
          isFlexible: data.isFlexible ?? false,
        })
        .returning();

      return row;
    },

    /**
     * List budget allocations, optionally filtered by parent policy.
     */
    listAllocations: async (companyId: string, parentPolicyId?: string) => {
      const conditions = [eq(budgetAllocations.companyId, companyId)];
      if (parentPolicyId) {
        conditions.push(eq(budgetAllocations.parentPolicyId, parentPolicyId));
      }

      return db
        .select()
        .from(budgetAllocations)
        .where(and(...conditions));
    },

    /**
     * Record a resource usage event (compute, storage, API calls, etc.).
     */
    recordResourceUsage: async (
      companyId: string,
      data: {
        agentId?: string;
        projectId?: string;
        resourceType: string;
        resourceProvider: string;
        quantity: string;
        unit: string;
        costCents?: number;
        metadata?: Record<string, unknown>;
        occurredAt: Date;
      },
    ) => {
      const [row] = await db
        .insert(resourceUsageEvents)
        .values({
          companyId,
          agentId: data.agentId ?? null,
          projectId: data.projectId ?? null,
          resourceType: data.resourceType,
          resourceProvider: data.resourceProvider,
          quantity: data.quantity,
          unit: data.unit,
          costCents: data.costCents ?? null,
          metadata: data.metadata ?? null,
          occurredAt: data.occurredAt,
        })
        .returning();

      return row;
    },

    /**
     * Aggregate resource usage by type over a rolling window.
     */
    getResourceUsageSummary: async (
      companyId: string,
      opts?: {
        resourceType?: string;
        agentId?: string;
        days?: number;
      },
    ) => {
      const days = opts?.days ?? 30;
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const conditions = [
        eq(resourceUsageEvents.companyId, companyId),
        gte(resourceUsageEvents.occurredAt, since),
      ];
      if (opts?.resourceType) {
        conditions.push(eq(resourceUsageEvents.resourceType, opts.resourceType));
      }
      if (opts?.agentId) {
        conditions.push(eq(resourceUsageEvents.agentId, opts.agentId));
      }

      const rows = await db
        .select({
          resourceType: resourceUsageEvents.resourceType,
          totalQuantity: sql<number>`coalesce(sum(${resourceUsageEvents.quantity}::numeric), 0)::numeric`,
          totalCostCents: sql<number>`coalesce(sum(${resourceUsageEvents.costCents}), 0)::int`,
          unit: sql<string>`min(${resourceUsageEvents.unit})`,
        })
        .from(resourceUsageEvents)
        .where(and(...conditions))
        .groupBy(resourceUsageEvents.resourceType);

      return rows.map((row) => ({
        resourceType: row.resourceType,
        totalQuantity: Number(row.totalQuantity),
        totalCostCents: Number(row.totalCostCents),
        unit: row.unit,
      }));
    },
  };
}
