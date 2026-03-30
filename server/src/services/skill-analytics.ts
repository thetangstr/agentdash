import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { skillUsageEvents, companySkills, issues, agents } from "@paperclipai/db";

export function skillAnalyticsService(db: Db) {
  return {
    /**
     * Group skillUsageEvents by skillId within the last N days, count
     * occurrences, and join with companySkills for the skill name.
     */
    usageBySkill: async (
      companyId: string,
      opts?: { days?: number },
    ) => {
      const days = opts?.days ?? 30;
      const since = new Date();
      since.setDate(since.getDate() - days);

      const rows = await db
        .select({
          skillId: skillUsageEvents.skillId,
          skillName: companySkills.name,
          usageCount: sql<number>`count(*)::int`.as("usage_count"),
        })
        .from(skillUsageEvents)
        .innerJoin(
          companySkills,
          eq(skillUsageEvents.skillId, companySkills.id),
        )
        .where(
          and(
            eq(skillUsageEvents.companyId, companyId),
            gte(skillUsageEvents.usedAt, since),
          ),
        )
        .groupBy(skillUsageEvents.skillId, companySkills.name)
        .orderBy(desc(sql`count(*)`));

      return rows;
    },

    /**
     * Group skillUsageEvents for a specific skill by agentId, count
     * occurrences, and join with agents for the agent name.
     */
    usageByAgent: async (companyId: string, skillId: string) => {
      const rows = await db
        .select({
          agentId: skillUsageEvents.agentId,
          agentName: agents.name,
          usageCount: sql<number>`count(*)::int`.as("usage_count"),
        })
        .from(skillUsageEvents)
        .innerJoin(agents, eq(skillUsageEvents.agentId, agents.id))
        .where(
          and(
            eq(skillUsageEvents.companyId, companyId),
            eq(skillUsageEvents.skillId, skillId),
          ),
        )
        .groupBy(skillUsageEvents.agentId, agents.name)
        .orderBy(desc(sql`count(*)`));

      return rows;
    },

    /**
     * Join skillUsageEvents with issues on issueId. Count issues by
     * status (done vs cancelled vs other) and compute a success rate.
     */
    outcomeCorrelation: async (companyId: string, skillId: string) => {
      const rows = await db
        .select({
          issueStatus: issues.status,
          count: sql<number>`count(distinct ${skillUsageEvents.issueId})::int`.as("count"),
        })
        .from(skillUsageEvents)
        .innerJoin(issues, eq(skillUsageEvents.issueId, issues.id))
        .where(
          and(
            eq(skillUsageEvents.companyId, companyId),
            eq(skillUsageEvents.skillId, skillId),
          ),
        )
        .groupBy(issues.status);

      let totalIssuesWithSkill = 0;
      let doneCount = 0;

      for (const row of rows) {
        totalIssuesWithSkill += row.count;
        if (row.issueStatus === "done") {
          doneCount = row.count;
        }
      }

      const successRate =
        totalIssuesWithSkill > 0 ? doneCount / totalIssuesWithSkill : 0;

      return {
        totalIssuesWithSkill,
        successRate,
        avgIssueCompletionCount: doneCount,
      };
    },

    /**
     * Find companySkills that have no skillUsageEvents in the last N
     * days. Returns each skill's id, name, and last usage timestamp.
     */
    unusedSkills: async (companyId: string, daysSinceLastUse: number) => {
      const since = new Date();
      since.setDate(since.getDate() - daysSinceLastUse);

      const rows = await db
        .select({
          skillId: companySkills.id,
          skillName: companySkills.name,
          lastUsedAt: sql<Date | null>`max(${skillUsageEvents.usedAt})`.as(
            "last_used_at",
          ),
        })
        .from(companySkills)
        .leftJoin(
          skillUsageEvents,
          eq(companySkills.id, skillUsageEvents.skillId),
        )
        .where(eq(companySkills.companyId, companyId))
        .groupBy(companySkills.id, companySkills.name)
        .having(
          sql`max(${skillUsageEvents.usedAt}) is null or max(${skillUsageEvents.usedAt}) < ${since}`,
        );

      return rows;
    },

    /**
     * Record a single skill usage event.
     */
    recordUsage: async (
      companyId: string,
      data: {
        skillId: string;
        versionId?: string;
        agentId: string;
        runId?: string;
        issueId?: string;
      },
    ) => {
      const [row] = await db
        .insert(skillUsageEvents)
        .values({
          companyId,
          skillId: data.skillId,
          versionId: data.versionId ?? null,
          agentId: data.agentId,
          runId: data.runId ?? null,
          issueId: data.issueId ?? null,
        })
        .returning();

      return row;
    },
  };
}
