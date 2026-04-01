import { and, eq, or, inArray, desc, gte, sql, not } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import { issues, approvals, activityLog, agents, issueComments } from "@agentdash/db";

// AgentDash: User Feed Service
// Computes a personalized, priority-ranked feed for a human operator.
// No new tables — aggregates over existing issues, approvals, and activity_log.

interface FeedItem {
  id: string;
  kind: "issue_assigned" | "issue_created_by_me" | "approval_pending" | "agent_activity" | "issue_updated";
  urgencyTier: "blocked" | "needs_decision" | "active" | "informational";
  urgencyRank: number;
  timestamp: string;
  issue?: Record<string, unknown> | null;
  approval?: Record<string, unknown> | null;
  agentActivity?: {
    agentId: string;
    agentName: string;
    action: string;
    entityType: string;
    entityId: string;
    details: Record<string, unknown> | null;
    createdAt: string;
  } | null;
}

const URGENCY_RANK: Record<string, number> = { blocked: 0, needs_decision: 1, active: 2, informational: 3 };
const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function issueUrgency(status: string): { tier: "blocked" | "needs_decision" | "active" | "informational"; rank: number } {
  switch (status) {
    case "blocked": return { tier: "blocked", rank: 0 };
    case "in_review": return { tier: "needs_decision", rank: 1 };
    case "in_progress": return { tier: "active", rank: 2 };
    case "todo": return { tier: "active", rank: 2 };
    default: return { tier: "informational", rank: 3 };
  }
}

export function feedService(db: Db) {
  return {
    getFeed: async (companyId: string, userId: string) => {
      const items: FeedItem[] = [];
      const seenEntities = new Set<string>();

      // Query 1: Issues assigned to me or created by me (non-terminal)
      const myIssues = await db
        .select()
        .from(issues)
        .where(and(
          eq(issues.companyId, companyId),
          or(
            eq(issues.assigneeUserId, userId),
            eq(issues.createdByUserId, userId),
          ),
          not(inArray(issues.status, ["done", "cancelled"])),
          sql`${issues.hiddenAt} IS NULL`,
        ))
        .orderBy(desc(issues.updatedAt))
        .limit(50);

      for (const issue of myIssues) {
        const { tier, rank } = issueUrgency(issue.status);
        const kind = issue.assigneeUserId === userId ? "issue_assigned" as const : "issue_created_by_me" as const;
        items.push({
          id: `${kind}:${issue.id}`,
          kind,
          urgencyTier: tier,
          urgencyRank: rank,
          timestamp: (issue.updatedAt ?? issue.createdAt).toISOString(),
          issue: { ...issue, createdAt: issue.createdAt.toISOString(), updatedAt: issue.updatedAt?.toISOString() },
        });
        seenEntities.add(`issue:${issue.id}`);
      }

      // Query 2: Pending approvals (company-wide — any board user can decide)
      const pendingApprovals = await db
        .select()
        .from(approvals)
        .where(and(
          eq(approvals.companyId, companyId),
          inArray(approvals.status, ["pending", "revision_requested"]),
        ))
        .orderBy(desc(approvals.createdAt))
        .limit(20);

      for (const approval of pendingApprovals) {
        items.push({
          id: `approval_pending:${approval.id}`,
          kind: "approval_pending",
          urgencyTier: "needs_decision",
          urgencyRank: 1,
          timestamp: approval.createdAt.toISOString(),
          approval: { ...approval, createdAt: approval.createdAt.toISOString(), updatedAt: approval.updatedAt?.toISOString() },
        });
      }

      // Query 3: Agent activity on my issues (last 7 days)
      const myIssueIds = myIssues.map((i) => i.id);
      if (myIssueIds.length > 0) {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const agentActivity = await db
          .select({
            id: activityLog.id,
            agentId: activityLog.agentId,
            action: activityLog.action,
            entityType: activityLog.entityType,
            entityId: activityLog.entityId,
            details: activityLog.details,
            createdAt: activityLog.createdAt,
          })
          .from(activityLog)
          .where(and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.actorType, "agent"),
            eq(activityLog.entityType, "issue"),
            inArray(activityLog.entityId, myIssueIds.map(String)),
            gte(activityLog.createdAt, sevenDaysAgo),
          ))
          .orderBy(desc(activityLog.createdAt))
          .limit(30);

        // Get agent names
        const agentIds = [...new Set(agentActivity.filter((a) => a.agentId).map((a) => a.agentId!))];
        const agentRows = agentIds.length > 0
          ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds))
          : [];
        const agentNameMap = new Map(agentRows.map((a) => [a.id, a.name]));

        for (const activity of agentActivity) {
          const key = `agent_activity:${activity.id}`;
          if (seenEntities.has(key)) continue;
          items.push({
            id: key,
            kind: "agent_activity",
            urgencyTier: "informational",
            urgencyRank: 3,
            timestamp: activity.createdAt.toISOString(),
            agentActivity: {
              agentId: activity.agentId ?? "",
              agentName: agentNameMap.get(activity.agentId ?? "") ?? "Unknown Agent",
              action: activity.action,
              entityType: activity.entityType ?? "unknown",
              entityId: activity.entityId ?? "",
              details: activity.details as Record<string, unknown> | null,
              createdAt: activity.createdAt.toISOString(),
            },
          });
          seenEntities.add(key);
        }
      }

      // Query 4: Issues I commented on that were recently updated
      const commentedIssueIds = await db
        .select({ issueId: issueComments.issueId })
        .from(issueComments)
        .where(and(
          eq(issueComments.companyId, companyId),
          eq(issueComments.authorUserId, userId),
        ))
        .then((rows) => [...new Set(rows.map((r) => r.issueId))]);

      const unseenCommentedIds = commentedIssueIds.filter((id) => !seenEntities.has(`issue:${id}`));
      if (unseenCommentedIds.length > 0) {
        const recentUpdated = await db
          .select()
          .from(issues)
          .where(and(
            eq(issues.companyId, companyId),
            inArray(issues.id, unseenCommentedIds),
            not(inArray(issues.status, ["done", "cancelled"])),
            sql`${issues.hiddenAt} IS NULL`,
          ))
          .orderBy(desc(issues.updatedAt))
          .limit(20);

        for (const issue of recentUpdated) {
          items.push({
            id: `issue_updated:${issue.id}`,
            kind: "issue_updated",
            urgencyTier: "informational",
            urgencyRank: 3,
            timestamp: (issue.updatedAt ?? issue.createdAt).toISOString(),
            issue: { ...issue, createdAt: issue.createdAt.toISOString(), updatedAt: issue.updatedAt?.toISOString() },
          });
        }
      }

      // Sort: urgency tier → issue priority → timestamp desc
      items.sort((a, b) => {
        if (a.urgencyRank !== b.urgencyRank) return a.urgencyRank - b.urgencyRank;
        const aPrio = PRIORITY_RANK[(a.issue as any)?.priority ?? "medium"] ?? 2;
        const bPrio = PRIORITY_RANK[(b.issue as any)?.priority ?? "medium"] ?? 2;
        if (aPrio !== bPrio) return aPrio - bPrio;
        return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      });

      // Limit
      const limited = items.slice(0, 100);

      // Counts
      const counts = {
        blocked: limited.filter((i) => i.urgencyTier === "blocked").length,
        needsDecision: limited.filter((i) => i.urgencyTier === "needs_decision").length,
        active: limited.filter((i) => i.urgencyTier === "active").length,
        informational: limited.filter((i) => i.urgencyTier === "informational").length,
        total: limited.length,
      };

      return { items: limited, counts };
    },
  };
}
