import { and, eq, gte, isNull, isNotNull, ne, sql } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import {
  agents,
  agentTemplates,
  costEvents,
  heartbeatRuns,
  issues,
  projects,
} from "@agentdash/db";
import { notFound, unprocessable } from "../errors.js";

export function capacityPlanningService(db: Db) {
  return {
    /**
     * Snapshot of the workforce: agent counts broken down by status and role.
     */
    getWorkforceSnapshot: async (companyId: string) => {
      const statusRows = await db
        .select({
          status: agents.status,
          count: sql<number>`count(*)::int`,
        })
        .from(agents)
        .where(eq(agents.companyId, companyId))
        .groupBy(agents.status);

      const roleRows = await db
        .select({
          role: agents.role,
          count: sql<number>`count(*)::int`,
        })
        .from(agents)
        .where(eq(agents.companyId, companyId))
        .groupBy(agents.role);

      const byStatus: Record<string, number> = {};
      let totalAgents = 0;
      let activeAgents = 0;
      let pausedAgents = 0;
      for (const row of statusRows) {
        const count = Number(row.count);
        byStatus[row.status] = count;
        totalAgents += count;
        if (row.status === "active" || row.status === "idle" || row.status === "running") {
          activeAgents += count;
        }
        if (row.status === "paused") {
          pausedAgents += count;
        }
      }

      const byRole: Record<string, number> = {};
      for (const row of roleRows) {
        byRole[row.role] = Number(row.count);
      }

      return {
        totalAgents,
        byStatus,
        byRole,
        activeAgents,
        pausedAgents,
      };
    },

    /**
     * Count issues by status, optionally scoped to a project.
     */
    getTaskPipeline: async (companyId: string, projectId?: string) => {
      const conditions = [eq(issues.companyId, companyId)];
      if (projectId) {
        conditions.push(eq(issues.projectId, projectId));
      }

      const statusRows = await db
        .select({
          status: issues.status,
          count: sql<number>`count(*)::int`,
        })
        .from(issues)
        .where(and(...conditions))
        .groupBy(issues.status);

      const [unassignedRow] = await db
        .select({
          count: sql<number>`count(*)::int`,
        })
        .from(issues)
        .where(
          and(
            ...conditions,
            isNull(issues.assigneeAgentId),
          ),
        );

      const byStatus: Record<string, number> = {};
      let totalIssues = 0;
      for (const row of statusRows) {
        const count = Number(row.count);
        byStatus[row.status] = count;
        totalIssues += count;
      }

      return {
        totalIssues,
        byStatus,
        unassigned: Number(unassignedRow?.count ?? 0),
      };
    },

    /**
     * Estimate remaining capacity for a project based on open tasks,
     * active agents, and average heartbeat run completion time.
     */
    estimateProjectCapacity: async (projectId: string) => {
      const [project] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, projectId));

      if (!project) throw notFound("Project not found");

      // Count remaining open issues (not done/cancelled)
      const [remainingRow] = await db
        .select({
          count: sql<number>`count(*)::int`,
        })
        .from(issues)
        .where(
          and(
            eq(issues.projectId, projectId),
            ne(issues.status, "done"),
            ne(issues.status, "cancelled"),
          ),
        );
      const remainingTasks = Number(remainingRow?.count ?? 0);

      // Count distinct active agents assigned to issues in this project
      const [activeAgentsRow] = await db
        .select({
          count: sql<number>`count(distinct ${issues.assigneeAgentId})::int`,
        })
        .from(issues)
        .innerJoin(agents, eq(issues.assigneeAgentId, agents.id))
        .where(
          and(
            eq(issues.projectId, projectId),
            ne(issues.status, "done"),
            ne(issues.status, "cancelled"),
            isNotNull(issues.assigneeAgentId),
            ne(agents.status, "paused"),
          ),
        );
      const activeAgents = Number(activeAgentsRow?.count ?? 0);

      const tasksPerAgent = activeAgents > 0 ? Math.round(remainingTasks / activeAgents) : remainingTasks;

      // Estimate average completion time from heartbeat runs for agents on this project
      const agentIdsSubquery = db
        .selectDistinct({ agentId: issues.assigneeAgentId })
        .from(issues)
        .where(
          and(
            eq(issues.projectId, projectId),
            isNotNull(issues.assigneeAgentId),
          ),
        );

      const [avgTimeRow] = await db
        .select({
          avgMinutes: sql<number>`coalesce(avg(extract(epoch from (${heartbeatRuns.finishedAt} - ${heartbeatRuns.startedAt})) / 60.0), 0)::numeric`,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.status, "succeeded"),
            isNotNull(heartbeatRuns.startedAt),
            isNotNull(heartbeatRuns.finishedAt),
            sql`${heartbeatRuns.agentId} in (${agentIdsSubquery})`,
          ),
        );

      const avgMinutesPerRun = Number(avgTimeRow?.avgMinutes ?? 0);
      // Estimate days: (remaining tasks * avg minutes per task) / (active agents * minutes per work day)
      const minutesPerDay = 24 * 60; // agents can work around the clock
      const estimatedDaysAtCurrentPace =
        activeAgents > 0 && avgMinutesPerRun > 0
          ? Math.ceil((remainingTasks * avgMinutesPerRun) / (activeAgents * minutesPerDay))
          : null;

      return {
        remainingTasks,
        activeAgents,
        tasksPerAgent,
        estimatedDaysAtCurrentPace,
      };
    },

    /**
     * Throughput metrics for a single agent over a rolling window.
     */
    getAgentThroughput: async (agentId: string, windowDays?: number) => {
      const days = windowDays ?? 30;
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      // Count issues completed in the window
      const [issueRow] = await db
        .select({
          count: sql<number>`count(*)::int`,
        })
        .from(issues)
        .where(
          and(
            eq(issues.assigneeAgentId, agentId),
            eq(issues.status, "done"),
            gte(issues.completedAt, since),
          ),
        );
      const issuesCompleted = Number(issueRow?.count ?? 0);

      // Average completion time from heartbeat runs
      const [avgRow] = await db
        .select({
          avgMinutes: sql<number>`coalesce(avg(extract(epoch from (${heartbeatRuns.finishedAt} - ${heartbeatRuns.startedAt})) / 60.0), 0)::numeric`,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agentId),
            eq(heartbeatRuns.status, "succeeded"),
            isNotNull(heartbeatRuns.startedAt),
            isNotNull(heartbeatRuns.finishedAt),
            gte(heartbeatRuns.startedAt, since),
          ),
        );
      const avgCompletionTimeMinutes = Math.round(Number(avgRow?.avgMinutes ?? 0));

      // Sum cost events
      const [costRow] = await db
        .select({
          total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.agentId, agentId),
            gte(costEvents.occurredAt, since),
          ),
        );
      const totalCostCents = Number(costRow?.total ?? 0);
      const costPerIssueCents = issuesCompleted > 0 ? Math.round(totalCostCents / issuesCompleted) : 0;

      return {
        issuesCompleted,
        avgCompletionTimeMinutes,
        totalCostCents,
        costPerIssueCents,
      };
    },

    /**
     * Recommend spawning additional agents for a project when the task backlog
     * is high relative to active agents. Matches agent templates by role.
     */
    recommendSpawns: async (companyId: string, projectId: string) => {
      const [project] = await db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.id, projectId),
            eq(projects.companyId, companyId),
          ),
        );
      if (!project) throw notFound("Project not found");

      // Get remaining tasks
      const [remainingRow] = await db
        .select({
          count: sql<number>`count(*)::int`,
        })
        .from(issues)
        .where(
          and(
            eq(issues.projectId, projectId),
            ne(issues.status, "done"),
            ne(issues.status, "cancelled"),
          ),
        );
      const remainingTasks = Number(remainingRow?.count ?? 0);

      // Count active agents on this project
      const [activeAgentsRow] = await db
        .select({
          count: sql<number>`count(distinct ${issues.assigneeAgentId})::int`,
        })
        .from(issues)
        .innerJoin(agents, eq(issues.assigneeAgentId, agents.id))
        .where(
          and(
            eq(issues.projectId, projectId),
            ne(issues.status, "done"),
            ne(issues.status, "cancelled"),
            isNotNull(issues.assigneeAgentId),
            ne(agents.status, "paused"),
          ),
        );
      const activeAgents = Number(activeAgentsRow?.count ?? 0);
      const tasksPerAgent = activeAgents > 0 ? remainingTasks / activeAgents : remainingTasks;

      // Only recommend if ratio exceeds threshold
      if (tasksPerAgent <= 5) {
        return [];
      }

      // Determine which roles are needed by looking at active issue assignees
      const roleRows = await db
        .select({
          role: agents.role,
          count: sql<number>`count(distinct ${agents.id})::int`,
        })
        .from(issues)
        .innerJoin(agents, eq(issues.assigneeAgentId, agents.id))
        .where(
          and(
            eq(issues.projectId, projectId),
            ne(issues.status, "done"),
            ne(issues.status, "cancelled"),
            isNotNull(issues.assigneeAgentId),
          ),
        )
        .groupBy(agents.role);

      const roles = roleRows.length > 0 ? roleRows.map((r) => r.role) : ["general"];

      // Find matching templates
      const templates = await db
        .select()
        .from(agentTemplates)
        .where(
          and(
            eq(agentTemplates.companyId, companyId),
            isNull(agentTemplates.archivedAt),
            sql`${agentTemplates.role} in (${sql.join(roles.map((r) => sql`${r}`), sql`, `)})`,
          ),
        );

      // Calculate how many additional agents are recommended
      const idealAgents = Math.ceil(remainingTasks / 5);
      const additionalNeeded = Math.max(0, idealAgents - activeAgents);

      if (templates.length === 0 || additionalNeeded === 0) {
        return [];
      }

      // Distribute across available templates
      const perTemplate = Math.max(1, Math.ceil(additionalNeeded / templates.length));

      return templates.map((template) => ({
        templateSlug: template.slug,
        templateName: template.name,
        quantity: perTemplate,
        reason: `${remainingTasks} tasks with ${activeAgents} active agents (${Math.round(tasksPerAgent)} tasks/agent). Recommend spawning to bring ratio below 5.`,
        estimatedMonthlyCostCents: template.budgetMonthlyCents * perTemplate,
      }));
    },
  };
}
