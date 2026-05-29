import { and, eq, gte, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, approvals, companies, costEvents, heartbeatRuns, issues, verdicts } from "@paperclipai/db";
import { notFound } from "../errors.js";
import { budgetService } from "./budgets.js";
import type {
  DashboardHarnessAdapterHealth,
  DashboardHarnessHealth,
  DashboardHarnessStatus,
} from "@paperclipai/shared";
import { definitionOfDoneSchema } from "@paperclipai/shared";

const DASHBOARD_RUN_ACTIVITY_DAYS = 14;
const HARNESS_HEALTH_WINDOW_HOURS = 24;
const TASK_QUALITY_WINDOW_DAYS = 30;
const HARNESS_TERMINAL_RUN_STATUSES = ["succeeded", "failed", "timed_out", "cancelled"] as const;

function formatUtcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function getUtcMonthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function getRecentUtcDateKeys(now: Date, days: number): string[] {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, index) => {
    const dayOffset = index - (days - 1);
    return formatUtcDateKey(new Date(todayUtc + dayOffset * 24 * 60 * 60 * 1000));
  });
}

function readFailureCategory(resultJson: unknown) {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) return "unknown";
  const result = resultJson as Record<string, unknown>;
  const failure = result.failureClassification;
  if (!failure || typeof failure !== "object" || Array.isArray(failure)) return "unknown";
  const category = (failure as Record<string, unknown>).category;
  return typeof category === "string" && category.trim().length > 0 ? category.trim() : "unknown";
}

function readIssueIdFromRunContext(contextSnapshot: unknown) {
  if (!contextSnapshot || typeof contextSnapshot !== "object" || Array.isArray(contextSnapshot)) return null;
  const context = contextSnapshot as Record<string, unknown>;
  const issueId = context.issueId ?? context.taskId;
  return typeof issueId === "string" && issueId.length > 0 ? issueId : null;
}

function harnessStatus(failedRuns: number, failureRatePercent: number): DashboardHarnessStatus {
  if (failedRuns >= 3 && failureRatePercent >= 50) return "critical";
  if (failedRuns > 0) return "warn";
  return "ok";
}

function compareHarnessStatus(a: DashboardHarnessStatus, b: DashboardHarnessStatus) {
  const rank: Record<DashboardHarnessStatus, number> = { ok: 0, warn: 1, critical: 2 };
  return rank[a] - rank[b];
}

function topCategory(categories: Map<string, number>) {
  const entries = Array.from(categories.entries());
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries[0]?.[0] ?? null;
}

export function dashboardService(db: Db) {
  const budgets = budgetService(db);
  return {
    summary: async (companyId: string) => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      const agentRows = await db
        .select({ status: agents.status, count: sql<number>`count(*)` })
        .from(agents)
        .where(eq(agents.companyId, companyId))
        .groupBy(agents.status);

      const taskRows = await db
        .select({ status: issues.status, count: sql<number>`count(*)` })
        .from(issues)
        .where(eq(issues.companyId, companyId))
        .groupBy(issues.status);

      const pendingApprovals = await db
        .select({ count: sql<number>`count(*)` })
        .from(approvals)
        .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
        .then((rows) => Number(rows[0]?.count ?? 0));

      const agentCounts: Record<string, number> = {
        active: 0,
        running: 0,
        paused: 0,
        error: 0,
      };
      for (const row of agentRows) {
        const count = Number(row.count);
        // "idle" agents are operational — count them as active
        const bucket = row.status === "idle" ? "active" : row.status;
        agentCounts[bucket] = (agentCounts[bucket] ?? 0) + count;
      }

      const taskCounts: Record<string, number> = {
        open: 0,
        inProgress: 0,
        blocked: 0,
        done: 0,
      };
      for (const row of taskRows) {
        const count = Number(row.count);
        if (row.status === "in_progress") taskCounts.inProgress += count;
        if (row.status === "blocked") taskCounts.blocked += count;
        if (row.status === "done") taskCounts.done += count;
        if (row.status !== "done" && row.status !== "cancelled") taskCounts.open += count;
      }

      const now = new Date();
      const monthStart = getUtcMonthStart(now);
      const runActivityDays = getRecentUtcDateKeys(now, DASHBOARD_RUN_ACTIVITY_DAYS);
      const runActivityStart = new Date(`${runActivityDays[0]}T00:00:00.000Z`);
      const [{ monthSpend }] = await db
        .select({
          monthSpend: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, monthStart),
          ),
        );

      const monthSpendCents = Number(monthSpend);
      const runActivityDayExpr = sql<string>`to_char(${heartbeatRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
      const runActivityRows = await db
        .select({
          date: runActivityDayExpr,
          status: heartbeatRuns.status,
          count: sql<number>`count(*)::double precision`,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            gte(heartbeatRuns.createdAt, runActivityStart),
          ),
        )
        .groupBy(runActivityDayExpr, heartbeatRuns.status);

      const runActivity = new Map(
        runActivityDays.map((date) => [
          date,
          { date, succeeded: 0, failed: 0, other: 0, total: 0 },
        ]),
      );
      for (const row of runActivityRows) {
        const bucket = runActivity.get(row.date);
        if (!bucket) continue;
        const count = Number(row.count);
        if (row.status === "succeeded") bucket.succeeded += count;
        else if (row.status === "failed" || row.status === "timed_out") bucket.failed += count;
        else bucket.other += count;
        bucket.total += count;
      }

      const harnessWindowStart = new Date(now.getTime() - HARNESS_HEALTH_WINDOW_HOURS * 60 * 60 * 1000);
      const harnessRunRows = await db
        .select({
          status: heartbeatRuns.status,
          agentId: heartbeatRuns.agentId,
          adapterType: agents.adapterType,
          resultJson: heartbeatRuns.resultJson,
          createdAt: heartbeatRuns.createdAt,
        })
        .from(heartbeatRuns)
        .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            gte(heartbeatRuns.createdAt, harnessWindowStart),
            inArray(heartbeatRuns.status, [...HARNESS_TERMINAL_RUN_STATUSES]),
          ),
        );

      const harnessByAdapter = new Map<
        string,
        {
          totalRuns: number;
          failedRuns: number;
          affectedAgents: Set<string>;
          latestFailureAt: Date | null;
          categories: Map<string, number>;
        }
      >();
      let harnessTotalRuns = 0;
      let harnessFailedRuns = 0;

      for (const row of harnessRunRows) {
        harnessTotalRuns += 1;
        const adapter = harnessByAdapter.get(row.adapterType) ?? {
          totalRuns: 0,
          failedRuns: 0,
          affectedAgents: new Set<string>(),
          latestFailureAt: null,
          categories: new Map<string, number>(),
        };
        adapter.totalRuns += 1;
        const failed = row.status === "failed" || row.status === "timed_out";
        if (failed) {
          harnessFailedRuns += 1;
          adapter.failedRuns += 1;
          adapter.affectedAgents.add(row.agentId);
          if (!adapter.latestFailureAt || row.createdAt > adapter.latestFailureAt) {
            adapter.latestFailureAt = row.createdAt;
          }
          const category = readFailureCategory(row.resultJson);
          adapter.categories.set(category, (adapter.categories.get(category) ?? 0) + 1);
        }
        harnessByAdapter.set(row.adapterType, adapter);
      }

      const harnessAdapters: DashboardHarnessAdapterHealth[] = Array.from(harnessByAdapter.entries())
        .map(([adapterType, adapter]) => {
          const failureRatePercent = adapter.totalRuns > 0
            ? Number(((adapter.failedRuns / adapter.totalRuns) * 100).toFixed(2))
            : 0;
          return {
            adapterType,
            status: harnessStatus(adapter.failedRuns, failureRatePercent),
            totalRuns: adapter.totalRuns,
            failedRuns: adapter.failedRuns,
            failureRatePercent,
            affectedAgents: adapter.affectedAgents.size,
            latestFailureAt: adapter.latestFailureAt?.toISOString() ?? null,
            topFailureCategory: topCategory(adapter.categories),
          };
        })
        .sort((a, b) =>
          compareHarnessStatus(b.status, a.status)
          || b.failedRuns - a.failedRuns
          || b.failureRatePercent - a.failureRatePercent
          || a.adapterType.localeCompare(b.adapterType)
        );

      const harnessFailureRatePercent = harnessTotalRuns > 0
        ? Number(((harnessFailedRuns / harnessTotalRuns) * 100).toFixed(2))
        : 0;
      const harnessHealth: DashboardHarnessHealth = {
        windowHours: HARNESS_HEALTH_WINDOW_HOURS,
        overallStatus: harnessStatus(harnessFailedRuns, harnessFailureRatePercent),
        totalRuns: harnessTotalRuns,
        failedRuns: harnessFailedRuns,
        failureRatePercent: harnessFailureRatePercent,
        adapters: harnessAdapters,
      };

      const taskQualityStart = new Date(now.getTime() - TASK_QUALITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const taskQualityIssueRows = await db
        .select({
          id: issues.id,
          status: issues.status,
          definitionOfDone: issues.definitionOfDone,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            gte(issues.updatedAt, taskQualityStart),
            ne(issues.status, "cancelled"),
          ),
        );

      const taskQualityIssueIds = new Set(taskQualityIssueRows.map((row) => row.id));
      const taskQualityVerdictRows = await db
        .select({
          issueId: verdicts.issueId,
          outcome: verdicts.outcome,
          createdAt: verdicts.createdAt,
        })
        .from(verdicts)
        .where(
          and(
            eq(verdicts.companyId, companyId),
            eq(verdicts.entityType, "issue"),
            gte(verdicts.createdAt, taskQualityStart),
            isNotNull(verdicts.issueId),
          ),
        );

      const latestVerdictByIssueId = new Map<string, { outcome: string; createdAt: Date }>();
      for (const row of taskQualityVerdictRows) {
        if (!row.issueId || !taskQualityIssueIds.has(row.issueId)) continue;
        const existing = latestVerdictByIssueId.get(row.issueId);
        if (!existing || row.createdAt > existing.createdAt) {
          latestVerdictByIssueId.set(row.issueId, {
            outcome: row.outcome,
            createdAt: row.createdAt,
          });
        }
      }

      let passedIssues = 0;
      let failedIssues = 0;
      let revisionRequestedIssues = 0;
      let escalatedIssues = 0;
      for (const verdict of latestVerdictByIssueId.values()) {
        if (verdict.outcome === "passed") passedIssues += 1;
        else if (verdict.outcome === "failed") failedIssues += 1;
        else if (verdict.outcome === "revision_requested") revisionRequestedIssues += 1;
        else if (verdict.outcome === "escalated_to_human") escalatedIssues += 1;
      }
      const reviewedIssues = passedIssues + failedIssues + revisionRequestedIssues + escalatedIssues;
      const issuesWithDefinitionOfDone = taskQualityIssueRows.filter((row) =>
        definitionOfDoneSchema.safeParse(row.definitionOfDone).success
      ).length;
      const unreviewedDoneIssues = taskQualityIssueRows.filter(
        (row) => row.status === "done" && !latestVerdictByIssueId.has(row.id),
      ).length;

      const taskQualityCostRows = await db
        .select({
          costCents: costEvents.costCents,
          inputTokens: costEvents.inputTokens,
          cachedInputTokens: costEvents.cachedInputTokens,
          outputTokens: costEvents.outputTokens,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, taskQualityStart),
            isNotNull(costEvents.issueId),
          ),
        );
      const issueLinkedSpendCents = taskQualityCostRows.reduce((sum, row) => sum + Number(row.costCents), 0);
      const issueLinkedTokens = taskQualityCostRows.reduce(
        (sum, row) => sum + Number(row.inputTokens) + Number(row.cachedInputTokens) + Number(row.outputTokens),
        0,
      );

      const taskQualityRunRows = await db
        .select({
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.status, "succeeded"),
            gte(heartbeatRuns.createdAt, taskQualityStart),
          ),
        );
      const greenRunsPendingReview = taskQualityRunRows.filter((row) => {
        const issueId = readIssueIdFromRunContext(row.contextSnapshot);
        return Boolean(issueId && taskQualityIssueIds.has(issueId) && !latestVerdictByIssueId.has(issueId));
      }).length;

      const issuesInScope = taskQualityIssueRows.length;
      const taskQuality = {
        windowDays: TASK_QUALITY_WINDOW_DAYS,
        issuesInScope,
        issuesWithDefinitionOfDone,
        dodCoveragePercent: issuesInScope > 0
          ? Number(((issuesWithDefinitionOfDone / issuesInScope) * 100).toFixed(2))
          : 0,
        reviewedIssues,
        passedIssues,
        failedIssues,
        revisionRequestedIssues,
        escalatedIssues,
        unreviewedDoneIssues,
        acceptanceRatePercent: reviewedIssues > 0
          ? Number(((passedIssues / reviewedIssues) * 100).toFixed(2))
          : 0,
        greenRunsPendingReview,
        issueLinkedSpendCents,
        issueLinkedTokens,
        spendPerAcceptedIssueCents: passedIssues > 0
          ? Math.round(issueLinkedSpendCents / passedIssues)
          : null,
      };

      const utilization =
        company.budgetMonthlyCents > 0
          ? (monthSpendCents / company.budgetMonthlyCents) * 100
          : 0;
      const budgetOverview = await budgets.overview(companyId);

      return {
        companyId,
        agents: {
          active: agentCounts.active,
          running: agentCounts.running,
          paused: agentCounts.paused,
          error: agentCounts.error,
        },
        tasks: taskCounts,
        costs: {
          monthSpendCents,
          monthBudgetCents: company.budgetMonthlyCents,
          monthUtilizationPercent: Number(utilization.toFixed(2)),
        },
        pendingApprovals,
        budgets: {
          activeIncidents: budgetOverview.activeIncidents.length,
          pendingApprovals: budgetOverview.pendingApprovalCount,
          pausedAgents: budgetOverview.pausedAgentCount,
          pausedProjects: budgetOverview.pausedProjectCount,
        },
        runActivity: Array.from(runActivity.values()),
        harness: harnessHealth,
        taskQuality,
      };
    },
  };
}
