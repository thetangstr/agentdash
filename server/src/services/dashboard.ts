import { and, desc, eq, gte, inArray, isNotNull, isNull, ne, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  companies,
  costEvents,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  verdicts,
} from "@paperclipai/db";
import { notFound } from "../errors.js";
import { budgetService } from "./budgets.js";
import type {
  DashboardHarnessAdapterHealth,
  DashboardHarnessHealth,
  DashboardHarnessStatus,
  WorkingNow,
} from "@paperclipai/shared";
import { definitionOfDoneSchema } from "@paperclipai/shared";
import { redactRunLogText } from "./run-log-redaction.js";

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

/** Home shows six rows per block; the total says how many more. */
const WORKING_NOW_LIMIT = 6;
const LAST_STEP_MAX = 160;

function clipStep(text: string | null | undefined): string | null {
  if (!text) return null;
  // AgentDash (GH #992): nextAction/livenessReason/event messages are
  // adapter-derived text — secret-redact before clipping into the dashboard.
  const oneLine = redactRunLogText(text).replace(/\s+/g, " ").trim();
  if (!oneLine) return null;
  return oneLine.length > LAST_STEP_MAX ? `${oneLine.slice(0, LAST_STEP_MAX - 1)}…` : oneLine;
}

export function dashboardService(db: Db) {
  const budgets = budgetService(db);
  return {
    /**
     * AgentDash: UX-3 (#784) — Home's "Working now". Every queued or running
     * heartbeat run, with the issue it is on (title, not a run hash), the
     * agent, its last step and when it started. One row per issue: two runs
     * on one issue show once, as the newest. `visibleWhere` is the caller's
     * restricted-project visibility over issues.project_id; a run on an
     * issue the caller cannot see is dropped, not shown untitled.
     */
    workingNow: async (companyId: string, opts: { visibleWhere?: SQL } = {}): Promise<WorkingNow> => {
      const runIssueId = sql<string | null>`coalesce(${heartbeatRuns.contextSnapshot} ->> 'issueId', ${heartbeatRuns.contextSnapshot} ->> 'taskId')`;
      // Hidden issues join as absent, like deleted ones.
      const issueJoin = and(
        eq(issues.companyId, companyId),
        isNull(issues.hiddenAt),
        sql`${issues.id}::text = ${runIssueId}`,
      );
      const liveWhere = and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.status, ["queued", "running"]),
        // A run whose context names an issue we could not join (deleted,
        // hidden, another company's, or in a project this caller cannot see)
        // is dropped rather than shown bare.
        sql`(${issues.id} is not null or ${runIssueId} is null)`,
        ...(opts.visibleWhere ? [sql`(${issues.id} is null or ${opts.visibleWhere})`] : []),
      );
      // One row per issue (runs outside an issue count on their own).
      const groupKey = sql<string>`coalesce(${issues.id}::text, ${heartbeatRuns.id}::text)`;

      // Newest run per issue, in SQL, then the newest WORKING_NOW_LIMIT of those.
      const perIssue = db
        .selectDistinctOn([groupKey], {
          groupKey: groupKey.as("wn_group_key"),
          runId: sql<string>`${heartbeatRuns.id}`.as("wn_run_id"),
          status: sql<string>`${heartbeatRuns.status}`.as("wn_status"),
          startedAt: sql<Date | null>`${heartbeatRuns.startedAt}`.as("wn_started_at"),
          createdAt: sql<Date>`${heartbeatRuns.createdAt}`.as("wn_created_at"),
          nextAction: sql<string | null>`${heartbeatRuns.nextAction}`.as("wn_next_action"),
          livenessReason: sql<string | null>`${heartbeatRuns.livenessReason}`.as("wn_liveness_reason"),
          agentId: sql<string>`${agents.id}`.as("wn_agent_id"),
          agentName: sql<string>`${agents.name}`.as("wn_agent_name"),
          issueId: sql<string | null>`${issues.id}`.as("wn_issue_id"),
          issueIdentifier: sql<string | null>`${issues.identifier}`.as("wn_issue_identifier"),
          issueTitle: sql<string | null>`${issues.title}`.as("wn_issue_title"),
          issueStatus: sql<string | null>`${issues.status}`.as("wn_issue_status"),
        })
        .from(heartbeatRuns)
        .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
        .leftJoin(issues, issueJoin)
        .where(liveWhere)
        .orderBy(groupKey, desc(heartbeatRuns.createdAt))
        .as("working_now");
      const page = await db
        .select()
        .from(perIssue)
        .orderBy(desc(perIssue.createdAt))
        .limit(WORKING_NOW_LIMIT);
      const total = await db
        .select({ count: sql<number>`count(distinct ${groupKey})::int` })
        .from(heartbeatRuns)
        .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
        .leftJoin(issues, issueJoin)
        .where(liveWhere)
        .then((r) => Number(r[0]?.count ?? 0));

      const runIds = page.map((row) => row.runId);
      const latestEvents = runIds.length
        ? await db
            .selectDistinctOn([heartbeatRunEvents.runId], {
              runId: heartbeatRunEvents.runId,
              message: heartbeatRunEvents.message,
            })
            .from(heartbeatRunEvents)
            .where(
              and(
                eq(heartbeatRunEvents.companyId, companyId),
                inArray(heartbeatRunEvents.runId, runIds),
                isNotNull(heartbeatRunEvents.message),
              ),
            )
            .orderBy(heartbeatRunEvents.runId, desc(heartbeatRunEvents.seq))
        : [];
      const eventByRun = new Map(latestEvents.map((e) => [e.runId, e.message]));

      return {
        total,
        items: page.map((row) => ({
          runId: row.runId,
          status: row.status,
          agent: { id: row.agentId, name: row.agentName },
          issue: row.issueId
            ? {
                id: row.issueId,
                identifier: row.issueIdentifier ?? null,
                title: row.issueTitle ?? "",
                status: row.issueStatus ?? "",
              }
            : null,
          lastStep: clipStep(row.nextAction) ?? clipStep(eventByRun.get(row.runId)) ?? clipStep(row.livenessReason),
          startedAt: new Date(row.startedAt ?? row.createdAt).toISOString(),
        })),
      };
    },

    // AgentDash (GH #902): `budgetVisibleWhere` / `approvalVisibleWhere` keep
    // hidden projects' budget policies, incidents and overrides out of counts.
    summary: async (
      companyId: string,
      opts: {
        agentVisibleWhere?: SQL;
        issueVisibleWhere?: SQL;
        budgetVisibleWhere?: SQL;
        approvalVisibleWhere?: SQL;
        /** AgentDash: cost events this actor may see (agent + project visibility). */
        costVisibleWhere?: SQL;
      } = {},
    ) => {
      const company = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);

      if (!company) throw notFound("Company not found");

      // Agent visibility (2026-09-30): a member's counts cover what they can see.
      const agentRows = await db
        .select({ status: agents.status, count: sql<number>`count(*)` })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), opts.agentVisibleWhere))
        .groupBy(agents.status);

      const taskRows = await db
        .select({ status: issues.status, count: sql<number>`count(*)` })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), opts.issueVisibleWhere))
        .groupBy(issues.status);

      const pendingApprovals = await db
        .select({ count: sql<number>`count(*)` })
        .from(approvals)
        .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending"), opts.approvalVisibleWhere))
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
      // AgentDash: BYOK boxes record tokens with zero cost, so Home needs the
      // month's tokens to say something true when no dollars are metered.
      // AgentDash (scan 3 lane L): input + output only, the one definition the
      // Shipped page and the run page use. Counting cached input made Home
      // read 1.9M where Shipped read 221.2k for the same work.
      const [{ monthSpend, monthTokens }] = await db
        .select({
          monthSpend: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
          monthTokens: sql<number>`coalesce(sum(${costEvents.inputTokens} + ${costEvents.outputTokens}), 0)::double precision`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, monthStart),
            opts.costVisibleWhere,
          ),
        );

      const monthSpendCents = Number(monthSpend);
      // AgentDash (batch 4): unmetered runs leave no cost events, so spend and
      // tokens both read zero. The month's run count lets Home tell "nothing
      // ran" ($0.00) from "runs recorded no usage" (Not measured).
      const [{ monthRuns }] = await db
        .select({ monthRuns: sql<number>`count(*)::double precision` })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), gte(heartbeatRuns.createdAt, monthStart)));
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
      const taskQualityIssueStatusById = new Map(taskQualityIssueRows.map((row) => [row.id, row.status]));
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
      // AgentDash (batch 3): the shared display definition is input + output;
      // cached reads are listed beside it, never folded into the headline
      // number (the Costs page counts the same way).
      const issueLinkedTokens = taskQualityCostRows.reduce(
        (sum, row) => sum + Number(row.inputTokens) + Number(row.outputTokens),
        0,
      );
      const issueLinkedCachedTokens = taskQualityCostRows.reduce(
        (sum, row) => sum + Number(row.cachedInputTokens),
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
      const greenRunsWithOpenTasks = taskQualityRunRows.filter((row) => {
        const issueId = readIssueIdFromRunContext(row.contextSnapshot);
        if (!issueId || !taskQualityIssueIds.has(issueId)) return false;
        const status = taskQualityIssueStatusById.get(issueId);
        return Boolean(status && status !== "done" && status !== "cancelled");
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
        greenRunsWithOpenTasks,
        issueLinkedSpendCents,
        issueLinkedTokens,
        issueLinkedCachedTokens,
        spendPerAcceptedIssueCents: passedIssues > 0
          ? Math.round(issueLinkedSpendCents / passedIssues)
          : null,
      };

      const utilization =
        company.budgetMonthlyCents > 0
          ? (monthSpendCents / company.budgetMonthlyCents) * 100
          : 0;
      const budgetOverview = await budgets.overview(companyId, { visibleWhere: opts.budgetVisibleWhere });

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
          monthTokens: Number(monthTokens),
          monthRuns: Number(monthRuns),
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
