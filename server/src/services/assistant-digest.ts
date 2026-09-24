import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, notInArray, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  issues,
  issueWorkProducts,
  projects,
} from "@paperclipai/db";
import { agentAccountabilityService } from "./agent-accountability.js";
import { APPROVAL_RISK_ORDER, summarizeApprovalRisk } from "./approval-risk.js";

/**
 * AgentDash assistant MCP (M1, GH #676): "what changed since a time" for a
 * person asking their assistant, generalized from the steward digest in
 * `steward-inbox.ts`.
 *
 * The steward digest answers "what is waiting on you" as a projection over
 * CURRENT state, delivered to one of the steward's own machines. This one
 * answers a different question — "what changed since T" — for a board user
 * reaching the control plane over HTTP through their assistant. Two things
 * carry over unchanged:
 *
 * - **Audience**: the digest is scoped to the agents this person answers for
 *   (stewarded plus accountable), not the whole company. "What did my agents
 *   ship overnight" means THEIR agents; a company-wide firehose would bury
 *   the answer and would leak other people's agent activity into a personal
 *   assistant.
 * - **Honest bounds**: every section reports `total` and `shown` separately,
 *   so a capped list can never read as a complete one.
 *
 * Two things are deliberately approximate, and the docblock says so rather
 * than pretending precision:
 *
 * - "Shipped" means `status = done` with `completedAt` in the window
 *   (`updatedAt` as the fallback when completedAt is unset). There is no
 *   status-transition timestamp, so an issue reopened and re-closed inside
 *   the window appears once — the right answer for a digest either way.
 * - "Blocked" is two answers, not one: `blockedNow` is every issue whose
 *   status IS blocked right now regardless of when it entered that state —
 *   "is anything stuck" must not depend on the window or a caller hears
 *   "nothing is blocked" while eight tasks sit blocked. `newlyBlocked` is
 *   the in-window subset, with the caveat that `status = blocked` AND
 *   `updatedAt` in the window is the closest available proxy for "became
 *   blocked" — a blocked issue touched for any reason reports the same
 *   timestamp.
 */

/** How many of each section the digest will list. Counts are never capped. */
const DIGEST_LIMITS = { shipped: 10, blocked: 10, decisions: 10 } as const;

/** Statuses where a human decision is still possible — mirrors steward-inbox. */
const DECIDABLE_STATUSES = ["pending", "revision_requested"] as const;

export interface AssistantDigestInput {
  companyId: string;
  /**
   * The board user the assistant acts for. `null` is the `local_implicit`
   * bootstrap operator, who has no user id and answers for the whole company
   * — the same reading `requireDecisionActor` gives that actor ("admin").
   */
  userId: string | null;
  /** Window start, inclusive. */
  since: Date;
  /** Optional project scope for `whats_new(project: …)`. */
  projectId?: string | null;
}

export function assistantDigestService(db: Db) {
  const accountability = agentAccountabilityService(db);

  /**
   * The agents whose work this digest covers — the same resolution the
   * steward inbox uses, so the assistant digest and the inbox agree on what
   * "my agents" means. A user-less board actor (the local bootstrap operator)
   * answers for the whole company.
   */
  async function audienceAgents(companyId: string, userId: string | null) {
    const all = await db
      .select({ id: agents.id, name: agents.name, role: agents.role })
      .from(agents)
      .where(eq(agents.companyId, companyId));
    if (all.length === 0 || userId === null) return all;
    const resolved = await accountability.resolveForAgents(
      companyId,
      all.map((agent) => agent.id),
    );
    return all.filter((agent) => resolved.get(agent.id)?.userId === userId);
  }

  /**
   * "What's waiting on me" is broader than approvals: founder-decision
   * tasks are plain issues assigned to the person, and no approval row
   * ever names them. A user-less actor (the local bootstrap operator)
   * answers for the whole company, so every human-assigned open task
   * counts — the same reading the digest audience gives that actor.
   * `items` caps at 25; `total` is the real count.
   */
  async function tasksAssignedTo(companyId: string, userId: string | null) {
    const rows = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          isNull(issues.hiddenAt),
          userId === null ? isNotNull(issues.assigneeUserId) : eq(issues.assigneeUserId, userId),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .orderBy(desc(issues.updatedAt));
    return {
      total: rows.length,
      items: rows.slice(0, 25).map((row) => ({
        issueId: row.id,
        identifier: row.identifier,
        title: row.title,
        status: row.status,
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  }

  async function digest(input: AssistantDigestInput) {
    const asOf = new Date();
    const mine = await audienceAgents(input.companyId, input.userId);
    const nameById = new Map(mine.map((agent) => [agent.id, agent.name]));
    const agentIds = mine.map((agent) => agent.id);
    if (agentIds.length === 0) {
      return emptyDigest(asOf);
    }

    const issueConditions = [
      eq(issues.companyId, input.companyId),
      isNull(issues.hiddenAt),
      inArray(issues.assigneeAgentId, agentIds),
      ...(input.projectId ? [eq(issues.projectId, input.projectId)] : []),
    ];

    // 1. Shipped: done inside the window. `completedAt` is the real completion
      //    stamp; `updatedAt` is the documented fallback for rows closed before
      //    the column was written.
    // The window filter lives in SQL — completedAt-or-updatedAt as two typed
    // branches mirrors the fallback the projection reports, so no done row
    // outside the window is ever read into memory. (A raw sql`coalesce` binds
    // the Date without the column's driver mapping — hence the typed form.)
    const shipped = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        assigneeAgentId: issues.assigneeAgentId,
        projectId: issues.projectId,
        completedAt: issues.completedAt,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(
        and(
          ...issueConditions,
          eq(issues.status, "done"),
          or(
            and(isNotNull(issues.completedAt), gte(issues.completedAt, input.since)),
            and(isNull(issues.completedAt), gte(issues.updatedAt, input.since)),
          ),
        ),
      )
      .orderBy(desc(issues.updatedAt));

    // 2. Blocked, split into the two questions a person actually asks:
    //    blockedNow = everything currently stuck (window-independent);
    //    newlyBlocked = the in-window subset (see header note on the proxy).
    const blockedNow = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        assigneeAgentId: issues.assigneeAgentId,
        projectId: issues.projectId,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .where(and(...issueConditions, eq(issues.status, "blocked")))
      .orderBy(asc(issues.updatedAt));
    const newlyBlocked = blockedNow.filter(
      (row) => row.updatedAt.getTime() >= input.since.getTime(),
    );

    // 3. Decisions waiting: still decidable, so the count is "needs you now",
    //    not "opened in the window". Ranked by the board's own risk order.
    const openApprovals = await db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.companyId, input.companyId),
          // Approvals with no requesting agent are board-filed — they still
          // wait on a human, so dropping them would hide decidable work.
          or(
            inArray(approvals.requestedByAgentId, agentIds),
            isNull(approvals.requestedByAgentId),
          ),
          inArray(approvals.status, [...DECIDABLE_STATUSES]),
        ),
      );
    const ranked = openApprovals
      .map((approval) => ({
        approval,
        risk: summarizeApprovalRisk(approval.type, approval.payload),
      }))
      .sort((a, b) => {
        const byRisk = APPROVAL_RISK_ORDER[a.risk.level] - APPROVAL_RISK_ORDER[b.risk.level];
        if (byRisk !== 0) return byRisk;
        return a.approval.createdAt.getTime() - b.approval.createdAt.getTime();
      });

    // Work products ride along on shipped items — "what shipped" is the PR,
    // not the issue row. Projection only: type/provider/url/status/review
    // state/summary. `metadata` is deliberately NOT copied — it is free-form
    // and can carry provider internals a person-facing surface must not echo.
    const shippedIds = shipped.slice(0, DIGEST_LIMITS.shipped).map((row) => row.id);
    const workProductRows = shippedIds.length
      ? await db
          .select({
            issueId: issueWorkProducts.issueId,
            type: issueWorkProducts.type,
            provider: issueWorkProducts.provider,
            title: issueWorkProducts.title,
            url: issueWorkProducts.url,
            status: issueWorkProducts.status,
            reviewState: issueWorkProducts.reviewState,
            summary: issueWorkProducts.summary,
          })
          .from(issueWorkProducts)
          .where(
            and(
              eq(issueWorkProducts.companyId, input.companyId),
              inArray(issueWorkProducts.issueId, shippedIds),
            ),
          )
          .orderBy(desc(issueWorkProducts.createdAt))
      : [];
    const workProductsByIssue = new Map<string, typeof workProductRows>();
    for (const wp of workProductRows) {
      const list = workProductsByIssue.get(wp.issueId) ?? [];
      list.push(wp);
      workProductsByIssue.set(wp.issueId, list);
    }

    const projectIds = [...new Set(
      [...shipped, ...blockedNow]
        .map((row) => row.projectId)
        .filter((id): id is string => typeof id === "string"),
    )];
    const projectRows = projectIds.length
      ? await db
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(inArray(projects.id, projectIds))
      : [];
    const projectNameById = new Map(projectRows.map((row) => [row.id, row.name]));

    const issueItem = (row: {
      id: string;
      identifier: string | null;
      title: string;
      assigneeAgentId: string | null;
      projectId: string | null;
      updatedAt: Date;
    }) => ({
      issueId: row.id,
      identifier: row.identifier,
      title: row.title,
      agentName: row.assigneeAgentId ? nameById.get(row.assigneeAgentId) ?? null : null,
      project: row.projectId ? projectNameById.get(row.projectId) ?? null : null,
      updatedAt: row.updatedAt.toISOString(),
    });

    const shippedItems = shipped.slice(0, DIGEST_LIMITS.shipped).map((row) => ({
      ...issueItem(row),
      completedAt: (row.completedAt ?? row.updatedAt).toISOString(),
      workProducts: (workProductsByIssue.get(row.id) ?? []).map((wp) => ({
        type: wp.type,
        provider: wp.provider,
        title: wp.title,
        url: wp.url,
        status: wp.status,
        reviewState: wp.reviewState,
        summary: wp.summary,
      })),
    }));
    const blockedNowItems = blockedNow.slice(0, DIGEST_LIMITS.blocked).map(issueItem);
    const newlyBlockedItems = newlyBlocked.slice(0, DIGEST_LIMITS.blocked).map(issueItem);
    const decisionItems = ranked.slice(0, DIGEST_LIMITS.decisions).map(({ approval, risk }) => ({
      approvalId: approval.id,
      type: approval.type,
      agentName: approval.requestedByAgentId ? nameById.get(approval.requestedByAgentId) ?? null : null,
      risk,
      waitingSince: approval.createdAt.toISOString(),
    }));

    return {
      agentsAnsweredFor: mine.length,
      since: input.since.toISOString(),
      asOf: asOf.toISOString(),
      shipped: { total: shipped.length, shown: shippedItems.length, items: shippedItems },
      blockedNow: { total: blockedNow.length, shown: blockedNowItems.length, items: blockedNowItems },
      newlyBlocked: { total: newlyBlocked.length, shown: newlyBlockedItems.length, items: newlyBlockedItems },
      decisionsWaiting: { total: ranked.length, shown: decisionItems.length, items: decisionItems },
      truncated:
        shipped.length > shippedItems.length ||
        blockedNow.length > blockedNowItems.length ||
        newlyBlocked.length > newlyBlockedItems.length ||
        ranked.length > decisionItems.length,
    };
  }

  return { digest, audienceAgents, tasksAssignedTo };
}

function emptyDigest(asOf: Date) {
  return {
    agentsAnsweredFor: 0,
    since: null,
    asOf: asOf.toISOString(),
    shipped: { total: 0, shown: 0, items: [] as unknown[] },
    blockedNow: { total: 0, shown: 0, items: [] as unknown[] },
    newlyBlocked: { total: 0, shown: 0, items: [] as unknown[] },
    decisionsWaiting: { total: 0, shown: 0, items: [] as unknown[] },
    truncated: false,
  };
}
