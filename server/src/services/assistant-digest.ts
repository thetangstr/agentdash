import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  approvals,
  authUsers,
  companies,
  documents,
  goals,
  issueApprovals,
  issueDocuments,
  issues,
  issueWorkProducts,
  projects,
} from "@paperclipai/db";
import { agentAccountabilityService } from "./agent-accountability.js";
import { approvalBudgetProjectId } from "../routes/visibility.js";
import { WAITING_APPROVAL_STATUSES, scopeAndRankOpenApprovals } from "./waiting-on-you-rules.js";
// AgentDash: consolidation PR-A — provenance, attention and the briefing.
import {
  buildAttention,
  buildBriefing,
  kindForActivity,
  normalizeActorType,
  type AttentionItem,
  type BriefingDecision,
  type BriefingIssue,
  type RowSource,
} from "./assistant-provenance.js";

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
const DIGEST_LIMITS = { shipped: 10, blocked: 10, decisions: 10, changed: 20 } as const;

/**
 * AgentDash consolidation PR-A (design Rev 3 §4.2, §4.4).
 *
 * - `CHANGED_SCAN_LIMIT` bounds how many activity rows one digest reads; the
 *   response says when the scan hit it.
 * - `QUIET_DAYS`: "quiet" means open tasks but no attributable activity in
 *   this many days. The number is disclosed in the response.
 * - `LEAD_REPORT_KEY`: a lead report is an issue document with this key,
 *   last written by the project's lead agent.
 * - Company-level activity (no project) is kept only for these entity/action
 *   pairs; everything else must join to a visible project or is dropped.
 */
const CHANGED_SCAN_LIMIT = 500;
export const QUIET_DAYS = 3;
export const LEAD_REPORT_KEY = "lead-report";
const COMPANY_LEVEL_AGENT_ACTIONS = new Set(["agent.created", "agent.hired", "agent.terminated"]);
const LEAD_REPORT_EXCERPT = 280;


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
  /**
   * AgentDash consolidation PR-A: the project ids this caller may see
   * (`visibleProjectIds` below, computed from the one visibility rule in
   * routes/visibility.ts). Omitted = every project in the company, which is
   * only correct for callers that see everything; the route always passes it.
   */
  visibleProjectIds?: ReadonlySet<string>;
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
   *
   * UX-7 (#788): the manual-vs-machine split happens HERE, before the
   * 25-item cap, so every surface (Home, the Decisions page, the sidebar
   * badge, list_pending_decisions) reads the same groups and the badge
   * count is the true manual total, never the size of the slice. `manual`
   * is the main list — tasks a human filed; `other` is machine-generated
   * work (routines, evaluations, escalations — any non-manual originKind),
   * grouped under "Other activity" on the Decisions page.
   */
  async function tasksAssignedTo(companyId: string, userId: string | null) {
    const rows = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        updatedAt: issues.updatedAt,
        originKind: issues.originKind,
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

    const toTask = (row: (typeof rows)[number]) => ({
      issueId: row.id,
      identifier: row.identifier,
      title: row.title,
      status: row.status,
      updatedAt: row.updatedAt.toISOString(),
      originKind: row.originKind,
    });
    const manual = rows.filter((row) => (row.originKind ?? "manual") === "manual");
    const other = rows.filter((row) => (row.originKind ?? "manual") !== "manual");
    return {
      manual: { total: manual.length, items: manual.slice(0, 25).map(toTask) },
      other: { total: other.length, items: other.slice(0, 25).map(toTask) },
    };
  }

  async function agentScopedSections(input: AssistantDigestInput, asOf: Date) {
    const mine = await audienceAgents(input.companyId, input.userId);
    const nameById = new Map(mine.map((agent) => [agent.id, agent.name]));
    const agentIds = mine.map((agent) => agent.id);
    if (agentIds.length === 0) {
      return { result: emptyDigest(asOf), ranked: [] as RankedApproval[], nameById };
    }

    const issueConditions = [
      eq(issues.companyId, input.companyId),
      isNull(issues.hiddenAt),
      inArray(issues.assigneeAgentId, agentIds),
      ...(input.projectId ? [eq(issues.projectId, input.projectId)] : []),
      // AgentDash consolidation PR-A (review H3): the digest applies project
      // visibility. A task in a restricted project the caller cannot see is
      // not in their digest, whoever it is assigned to.
      ...(input.visibleProjectIds ? [visibleIssueCondition(input.visibleProjectIds)] : []),
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
          inArray(approvals.status, [...WAITING_APPROVAL_STATUSES]),
        ),
      );
    // AgentDash (GH #933): a budget_override_required approval's payload
    // names the scope's id, name and spend — for a project scope it follows
    // the project rule, the same check the approvals list applies as SQL,
    // here against the caller's visible project ids.
    const visibleProjects = input.visibleProjectIds;
    const scopedApprovals = visibleProjects
      ? openApprovals.filter((approval) => {
          const approvalProjectId = approvalBudgetProjectId(approval);
          return approvalProjectId === null || visibleProjects.has(approvalProjectId);
        })
      : openApprovals;
    // AgentDash: UX-3 (#784) — scope and rank exactly as the pending-decisions
    // list (and so the web Home) does; one definition of "waiting on you".
    const ranked = scopeAndRankOpenApprovals(scopedApprovals, new Set(agentIds));

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

    const result = {
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
    return { result, ranked: ranked as RankedApproval[], nameById };
  }


  /**
   * The project ids this caller may see in the company, from the ONE
   * visibility rule (`projectVisibilityCondition`, routes/visibility.ts).
   * The route passes the condition; `undefined` means the caller sees
   * everything.
   */
  async function visibleProjectIds(companyId: string, visibility: SQL | undefined) {
    const rows = await db
      .select({ id: projects.id })
      .from(projects)
      .where(visibility ? and(eq(projects.companyId, companyId), visibility) : eq(projects.companyId, companyId));
    return new Set(rows.map((row) => row.id));
  }

  async function namesFor(companyId: string, userIds: string[], agentIds: string[]) {
    const [userRows, agentRows] = await Promise.all([
      userIds.length
        ? db.select({ id: authUsers.id, name: authUsers.name }).from(authUsers).where(inArray(authUsers.id, userIds))
        : Promise.resolve([] as Array<{ id: string; name: string }>),
      agentIds.length
        ? db
            .select({ id: agents.id, name: agents.name })
            .from(agents)
            .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)))
        : Promise.resolve([] as Array<{ id: string; name: string }>),
    ]);
    return {
      users: new Map(userRows.map((row) => [row.id, row.name])),
      agents: new Map(agentRows.map((row) => [row.id, row.name])),
    };
  }

  function actorName(
    names: { users: Map<string, string>; agents: Map<string, string> },
    actorType: string,
    actorId: string,
  ): string | null {
    if (actorType === "user") return names.users.get(actorId) ?? "a board user";
    if (actorType === "agent") return names.agents.get(actorId) ?? "an agent";
    if (actorType === "system") return "AgentDash";
    if (actorType === "plugin") return "a plugin";
    return null;
  }

  async function digest(input: AssistantDigestInput) {
    const asOf = new Date();
    const { result: base, ranked, nameById } = await agentScopedSections(input, asOf);
    const visible = input.visibleProjectIds ?? (await visibleProjectIds(input.companyId, undefined));

    const [company] = await db
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, input.companyId));
    const projectRow = input.projectId
      ? await db
          .select({
            id: projects.id,
            name: projects.name,
            goalId: projects.goalId,
            leadAgentId: projects.leadAgentId,
          })
          .from(projects)
          .where(and(eq(projects.id, input.projectId), eq(projects.companyId, input.companyId)))
          .then((rows) => rows[0] ?? null)
      : null;
    const scopeName = projectRow
      ? `${company?.name ?? "this company"} / ${projectRow.name}`
      : company?.name ?? "this company";

    // ---- changed[] (§4.2): activity joined through its entity to a project.
    const quietSince = new Date(asOf.getTime() - QUIET_DAYS * 24 * 3_600_000);
    const scanFrom = input.since.getTime() < quietSince.getTime() ? input.since : quietSince;
    const activityRows = await db
      .select({
        id: activityLog.id,
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        action: activityLog.action,
        entityType: activityLog.entityType,
        entityId: activityLog.entityId,
        origin: activityLog.origin,
        details: activityLog.details,
        createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, input.companyId), gte(activityLog.createdAt, scanFrom)))
      .orderBy(desc(activityLog.createdAt))
      .limit(CHANGED_SCAN_LIMIT);
    const scanTruncated = activityRows.length >= CHANGED_SCAN_LIMIT;

    const uuidLike = (value: string) => /^[0-9a-f-]{36}$/i.test(value);
    const issueEntityIds = [...new Set(
      activityRows.filter((row) => row.entityType === "issue" && uuidLike(row.entityId)).map((row) => row.entityId),
    )];
    const approvalEntityIds = [...new Set(
      activityRows.filter((row) => row.entityType === "approval" && uuidLike(row.entityId)).map((row) => row.entityId),
    )];
    const projectEntityIds = [...new Set(
      activityRows.filter((row) => row.entityType === "project" && uuidLike(row.entityId)).map((row) => row.entityId),
    )];

    // Approval rows in the feed: the approval must exist in this company (a
    // row naming a missing approval is dropped), and a decision taken on the
    // assistant channel (#780 passes `channel: "assistant"`) reads "via
    // assistant" even on rows written before the gated path stamped `via`.
    const approvalEntityRows = approvalEntityIds.length
      ? await db
          .select({ id: approvals.id, decisionChannel: approvals.decisionChannel, type: approvals.type, payload: approvals.payload })
          .from(approvals)
          .where(and(eq(approvals.companyId, input.companyId), inArray(approvals.id, approvalEntityIds)))
      : [];
    const approvalChannelById = new Map(approvalEntityRows.map((row) => [row.id, row.decisionChannel]));
    const approvalById = new Map(approvalEntityRows.map((row) => [row.id, row]));
    const ASSISTANT_DECISION_ACTIONS = new Set([
      "approval.approved",
      "approval.rejected",
      "approval.revision_requested",
    ]);

    // Approvals map to projects only through issue_approvals (§4.3).
    const allApprovalIds = [...new Set([...approvalEntityIds, ...ranked.map((r) => r.approval.id)])];
    const approvalLinks = allApprovalIds.length
      ? await db
          .select({ approvalId: issueApprovals.approvalId, issueId: issueApprovals.issueId })
          .from(issueApprovals)
          .where(and(eq(issueApprovals.companyId, input.companyId), inArray(issueApprovals.approvalId, allApprovalIds)))
      : [];
    const linkedIssueIds = [...new Set(approvalLinks.map((link) => link.issueId))];
    const issueIdsToLoad = [...new Set([...issueEntityIds, ...linkedIssueIds])];
    const issueRows = issueIdsToLoad.length
      ? await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            status: issues.status,
            projectId: issues.projectId,
            hiddenAt: issues.hiddenAt,
            assigneeAgentId: issues.assigneeAgentId,
            assigneeUserId: issues.assigneeUserId,
          })
          .from(issues)
          .where(and(eq(issues.companyId, input.companyId), inArray(issues.id, issueIdsToLoad)))
      : [];
    const issueById = new Map(issueRows.map((row) => [row.id, row]));
    const projectEntityRows = projectEntityIds.length
      ? await db
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(and(eq(projects.companyId, input.companyId), inArray(projects.id, projectEntityIds)))
      : [];
    const allProjectNames = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.companyId, input.companyId));
    const projectNameById = new Map(allProjectNames.map((row) => [row.id, row.name]));
    const projectEntityIdSet = new Set(projectEntityRows.map((row) => row.id));
    const linksByApproval = new Map<string, string[]>();
    for (const link of approvalLinks) {
      const list = linksByApproval.get(link.approvalId) ?? [];
      list.push(link.issueId);
      linksByApproval.set(link.approvalId, list);
    }

    /** A visible, un-hidden issue in scope, or null. */
    const visibleIssue = (issueId: string) => {
      const issue = issueById.get(issueId);
      if (!issue || issue.hiddenAt) return null;
      if (issue.projectId && !visible.has(issue.projectId)) return null;
      return issue;
    };

    type Attribution = { projectId: string | null; issue: ReturnType<typeof visibleIssue>; companyLevel: boolean };
    const attribute = (row: (typeof activityRows)[number]): Attribution | null => {
      if (row.entityType === "issue") {
        const issue = visibleIssue(row.entityId);
        if (!issue) return null;
        return { projectId: issue.projectId, issue, companyLevel: issue.projectId === null };
      }
      if (row.entityType === "project") {
        if (!projectEntityIdSet.has(row.entityId) || !visible.has(row.entityId)) return null;
        return { projectId: row.entityId, issue: null, companyLevel: false };
      }
      if (row.entityType === "approval") {
        const approval = approvalById.get(row.entityId);
        if (!approval) return null; // no such approval here
        // AgentDash (GH #933): a budget_override_required approval is about
        // the project its payload scopes to — the activity row follows the
        // project rule, it is not company-level just because no issue links it.
        const budgetProjectId = approvalBudgetProjectId(approval);
        if (budgetProjectId) {
          if (!visible.has(budgetProjectId)) return null;
          return { projectId: budgetProjectId, issue: null, companyLevel: false };
        }
        const linked = linksByApproval.get(row.entityId);
        if (!linked || linked.length === 0) return { projectId: null, issue: null, companyLevel: true };
        // Linked approvals are attributed through their first visible issue;
        // one invisible link is enough to drop the row rather than guess.
        const seen = linked.map((id) => visibleIssue(id));
        if (seen.some((issue) => issue === null)) return null;
        const issue = seen[0]!;
        return { projectId: issue.projectId, issue, companyLevel: issue.projectId === null };
      }
      if (row.entityType === "agent" && COMPANY_LEVEL_AGENT_ACTIONS.has(row.action)) {
        return { projectId: null, issue: null, companyLevel: true };
      }
      return null; // unattributable: dropped, never guessed
    };

    const kept = activityRows
      .map((row) => ({ row, where: attribute(row) }))
      .filter((entry): entry is { row: (typeof activityRows)[number]; where: Attribution } => {
        if (!entry.where) return false;
        if (input.projectId) return entry.where.projectId === input.projectId;
        return true;
      });

    // Names for every actor we are about to show (activity + approvals).
    const userIds = new Set<string>();
    const agentIdsForNames = new Set<string>();
    for (const { row } of kept) {
      if (row.actorType === "user") userIds.add(row.actorId);
      if (row.actorType === "agent" && uuidLike(row.actorId)) agentIdsForNames.add(row.actorId);
    }
    for (const { approval } of ranked) {
      if (approval.requestedByUserId) userIds.add(approval.requestedByUserId);
      if (approval.requestedByAgentId) agentIdsForNames.add(approval.requestedByAgentId);
    }
    for (const issue of issueRows) if (issue.assigneeAgentId) agentIdsForNames.add(issue.assigneeAgentId);

    // Status provenance for shipped/blocked items: the latest server-side
    // status-change row for each issue, used only if it set the CURRENT
    // status. Anything else is "no recorded author" (agent_state).
    const sectionIssueIds = [...new Set(
      [...base.shipped.items, ...base.blockedNow.items, ...base.newlyBlocked.items]
        .map((item) => (item as { issueId?: string }).issueId)
        .filter((id): id is string => typeof id === "string"),
    )];
    const statusRows = sectionIssueIds.length
      ? await db
          .select({
            entityId: activityLog.entityId,
            actorType: activityLog.actorType,
            actorId: activityLog.actorId,
            origin: activityLog.origin,
            details: activityLog.details,
            createdAt: activityLog.createdAt,
          })
          .from(activityLog)
          .where(
            and(
              eq(activityLog.companyId, input.companyId),
              eq(activityLog.entityType, "issue"),
              inArray(activityLog.entityId, sectionIssueIds),
              sql`jsonb_exists(${activityLog.details}, 'status')`,
            ),
          )
          .orderBy(desc(activityLog.createdAt))
      : [];
    const latestStatusRow = new Map<string, (typeof statusRows)[number]>();
    for (const row of statusRows) if (!latestStatusRow.has(row.entityId)) latestStatusRow.set(row.entityId, row);
    for (const row of latestStatusRow.values()) {
      if (row.actorType === "user") userIds.add(row.actorId);
      if (row.actorType === "agent" && uuidLike(row.actorId)) agentIdsForNames.add(row.actorId);
    }
    const names = await namesFor(input.companyId, [...userIds], [...agentIdsForNames]);

    const activitySource = (row: {
      actorType: string;
      actorId: string;
      origin: string | null;
      details: Record<string, unknown> | null;
      createdAt: Date;
    }, entity: string, id: string, opts: { assistantChannel?: boolean } = {}): RowSource => {
      const derived = kindForActivity(row);
      const via = derived.via ?? (opts.assistantChannel ? "assistant" : undefined);
      const kind = via ? "agent_state" : derived.kind;
      // A row from before PR-C (origin NULL) could carry a forged actor, so
      // its stored name is never shown: the author is "origin unknown".
      if (row.origin === null) {
        return {
          kind: "agent_state",
          actor: { type: "unknown", name: null },
          origin: "unknown",
          ...(via ? { via } : {}),
          entity,
          id,
          recordedAt: row.createdAt.toISOString(),
        };
      }
      return {
        kind,
        actor: { type: normalizeActorType(row.actorType), name: actorName(names, row.actorType, row.actorId) },
        origin: row.origin === "manual" ? "manual" : "server",
        ...(via ? { via } : {}),
        entity,
        id,
        recordedAt: row.createdAt.toISOString(),
      };
    };

    const statusSource = (issueId: string, status: string): RowSource => {
      const row = latestStatusRow.get(issueId);
      if (!row || row.details?.status !== status) {
        return { kind: "agent_state", actor: { type: "unknown", name: null }, entity: "issue", id: issueId, recordedAt: null };
      }
      return activitySource(row, "issue", issueId);
    };

    const withSource = <T extends { issueId?: string }>(items: T[], status: string) =>
      items.map((item) => ({
        ...item,
        titleKind: "agent_text" as const,
        source: statusSource(item.issueId ?? "", status),
      }));

    const shipped = { ...base.shipped, items: withSource(base.shipped.items as Array<{ issueId?: string }>, "done") };
    const blockedNow = { ...base.blockedNow, items: withSource(base.blockedNow.items as Array<{ issueId?: string }>, "blocked") };
    const newlyBlocked = { ...base.newlyBlocked, items: withSource(base.newlyBlocked.items as Array<{ issueId?: string }>, "blocked") };

    // ---- Decisions (§4.3): company-wide by default; project calls split
    // into linked (via issue_approvals) and company-level (no linked issue).
    const approvalSource = (approval: RankedApproval["approval"]): RowSource => {
      // A hire filed through an assistant grant (request_hire) stamps
      // requestedByUserId but was requested by the assistant: via assistant.
      const metadata = (approval.payload as { metadata?: { source?: unknown } } | null)?.metadata;
      if (metadata?.source === "assistant_hire_request") {
        return {
          kind: "agent_state",
          actor: {
            type: approval.requestedByUserId ? "user" : "unknown",
            name: approval.requestedByUserId ? names.users.get(approval.requestedByUserId) ?? "a board user" : null,
          },
          via: "assistant",
          entity: "approval",
          id: approval.id,
          recordedAt: approval.createdAt.toISOString(),
        };
      }
      if (approval.requestedByAgentId) {
        return {
          kind: "agent_state",
          actor: { type: "agent", name: names.agents.get(approval.requestedByAgentId) ?? nameById.get(approval.requestedByAgentId) ?? "an agent" },
          entity: "approval",
          id: approval.id,
          recordedAt: approval.createdAt.toISOString(),
        };
      }
      if (approval.requestedByUserId) {
        return {
          kind: "human_or_system",
          actor: { type: "user", name: names.users.get(approval.requestedByUserId) ?? "a board user" },
          entity: "approval",
          id: approval.id,
          recordedAt: approval.createdAt.toISOString(),
        };
      }
      return { kind: "human_or_system", actor: { type: "system", name: "AgentDash" }, entity: "approval", id: approval.id, recordedAt: approval.createdAt.toISOString() };
    };
    const companyLabel = `in ${company?.name ?? "this company"}`;
    const decisionItem = (entry: RankedApproval, scope: "company" | "project" | "company-level", scopeLabel: string) => {
      const linkedIssue = (linksByApproval.get(entry.approval.id) ?? []).map((id) => visibleIssue(id)).find(Boolean) ?? null;
      return {
        approvalId: entry.approval.id,
        type: entry.approval.type,
        agentName: entry.approval.requestedByAgentId ? nameById.get(entry.approval.requestedByAgentId) ?? null : null,
        risk: entry.risk,
        waitingSince: entry.approval.createdAt.toISOString(),
        scope,
        scopeLabel,
        issueRef: linkedIssue ? linkedIssue.identifier ?? linkedIssue.id : null,
        source: approvalSource(entry.approval),
      };
    };
    const decisionsWaiting: Record<string, unknown> = {
      ...base.decisionsWaiting,
      items: (base.decisionsWaiting.items as Array<{ approvalId: string }>).map((item) => {
        const entry = ranked.find((r) => r.approval.id === item.approvalId);
        return entry ? { ...item, ...decisionItem(entry, "company", companyLabel) } : item;
      }),
      scope: "company",
      label: companyLabel,
    };
    let briefingDecisions: { total: number; items: BriefingDecision[]; breakdown?: string };
    if (projectRow) {
      const linked = ranked.filter((entry) => {
        // GH #933: a budget override scoped to this project is linked to it —
        // it just has no issue_approvals row to show it through.
        if (approvalBudgetProjectId(entry.approval) === projectRow.id) return true;
        const ids = linksByApproval.get(entry.approval.id) ?? [];
        return ids.some((id) => visibleIssue(id)?.projectId === projectRow.id);
      });
      const companyLevel = ranked.filter(
        (entry) =>
          (linksByApproval.get(entry.approval.id) ?? []).length === 0 &&
          // GH #933: an approval scoped to another project is not
          // company-level either — it is just not linked to THIS one.
          approvalBudgetProjectId(entry.approval) === null,
      );
      const levelLabel = `company-level, not tied to ${projectRow.name}`;
      const linkedItems = linked.slice(0, DIGEST_LIMITS.decisions).map((entry) => decisionItem(entry, "project", `linked to ${projectRow.name}`));
      const companyLevelItems = companyLevel.slice(0, DIGEST_LIMITS.decisions).map((entry) => decisionItem(entry, "company-level", levelLabel));
      decisionsWaiting.linked = { total: linked.length, shown: linkedItems.length, items: linkedItems };
      decisionsWaiting.companyLevel = { total: companyLevel.length, shown: companyLevelItems.length, items: companyLevelItems, label: levelLabel };
      briefingDecisions = {
        total: linked.length + companyLevel.length,
        breakdown: `${linked.length} linked to ${projectRow.name}, ${companyLevel.length} ${levelLabel}`,
        items: [...linkedItems, ...companyLevelItems].map((item) => ({
          approvalId: item.approvalId,
          type: item.type,
          scopeLabel: item.scopeLabel,
          source: item.source,
        })),
      };
    } else {
      const items = ranked.slice(0, DIGEST_LIMITS.decisions).map((entry) => decisionItem(entry, "company", companyLabel));
      briefingDecisions = {
        total: ranked.length,
        items: items.map((item) => ({ approvalId: item.approvalId, type: item.type, scopeLabel: item.scopeLabel, source: item.source })),
      };
    }

    // ---- changed[] projection: fixed fields only. `details` is NEVER
    // copied; the only "what changed" facts are re-read from the entity.
    const inWindow = kept.filter(({ row }) => row.createdAt.getTime() >= input.since.getTime());
    const changedItems = inWindow.slice(0, DIGEST_LIMITS.changed).map(({ row, where }) => {
      const issue = where.issue;
      const target = issue
        ? { type: "issue" as const, ref: issue.identifier ?? issue.id }
        : row.entityType === "approval"
          ? { type: "approval" as const, ref: row.entityId }
          : row.entityType === "project"
            ? { type: "project" as const, ref: row.entityId }
            : row.entityType === "agent"
              ? { type: "agent" as const, ref: row.entityId }
              : null;
      return {
        // `action` is free text on manual rows (the POST has no length
        // limit): clipped, and marked as written by the posting user.
        action: row.action.length > 80 ? `${row.action.slice(0, 79)}…` : row.action,
        actionKind: row.origin === "manual" ? ("user_text" as const) : ("event" as const),
        entityType: row.entityType,
        recordedAt: row.createdAt.toISOString(),
        project: where.projectId ? projectNameById.get(where.projectId) ?? null : null,
        scope: where.companyLevel ? "company-level" : "project",
        ref: issue?.identifier ?? null,
        title: issue ? issue.title : null,
        titleKind: issue ? ("agent_text" as const) : null,
        current: issue
          ? {
              status: issue.status,
              assignee: issue.assigneeAgentId ? names.agents.get(issue.assigneeAgentId) ?? null : null,
            }
          : null,
        target,
        source: activitySource(row, row.entityType, row.entityId, {
          assistantChannel:
            row.entityType === "approval" &&
            ASSISTANT_DECISION_ACTIONS.has(row.action) &&
            approvalChannelById.get(row.entityId) === "assistant",
        }),
      };
    });
    const changed = {
      total: inWindow.length,
      shown: changedItems.length,
      items: changedItems,
      scanTruncated,
    };

    // ---- freshness (§4.4)
    const openConditions = [
      eq(issues.companyId, input.companyId),
      isNull(issues.hiddenAt),
      notInArray(issues.status, ["done", "cancelled"]),
      ...(input.projectId ? [eq(issues.projectId, input.projectId)] : []),
      visibleIssueCondition(visible),
    ];
    const [{ openCount }] = await db
      .select({ openCount: sql<number>`count(*)::int` })
      .from(issues)
      .where(and(...openConditions));
    const newest = kept[0]?.row.createdAt ?? null;
    const recentActivity = kept.some(({ row }) => row.createdAt.getTime() >= quietSince.getTime());
    const quiet = openCount > 0 && !recentActivity;
    const freshness = {
      asOf: asOf.toISOString(),
      newestRecordAt: newest ? newest.toISOString() : null,
      quiet,
      quietDays: QUIET_DAYS,
      quietReason: quiet
        ? `${openCount} open task${openCount === 1 ? "" : "s"}, no recorded activity in the last ${QUIET_DAYS} days`
        : null,
    };

    // ---- attention[] and briefing (§4.4)
    const toBriefingIssue = (item: Record<string, unknown>): BriefingIssue => ({
      issueId: String(item.issueId ?? ""),
      identifier: (item.identifier as string | null) ?? null,
      title: String(item.title ?? ""),
      source: item.source as RowSource,
      prTitle: ((item.workProducts as Array<{ title?: string; url?: string | null }> | undefined) ?? []).find((wp) => wp.url)?.title ?? null,
    });
    const briefingInput = {
      scopeName,
      since: input.since,
      asOf,
      decisions: briefingDecisions,
      blocked: { total: blockedNow.total, items: (blockedNow.items as Array<Record<string, unknown>>).map(toBriefingIssue) },
      shipped: { total: shipped.total, items: (shipped.items as Array<Record<string, unknown>>).map(toBriefingIssue) },
      changedTotal: changed.total,
      quiet: { quiet, reason: freshness.quietReason },
      truncated: base.truncated || changed.total > changed.shown || scanTruncated,
    };
    const attention: AttentionItem[] = buildAttention({
      ...briefingInput,
      quietTarget: projectRow ? { type: "project", ref: projectRow.id } : { type: "company", ref: input.companyId },
    });
    const briefing = buildBriefing(briefingInput);

    // ---- project block for get_project (§4.5): linked goal + lead report.
    let project: Record<string, unknown> | null = null;
    if (projectRow) {
      const goal = projectRow.goalId
        ? await db
            .select({ id: goals.id, title: goals.title, status: goals.status, metric: goals.metricDefinition })
            .from(goals)
            .where(and(eq(goals.id, projectRow.goalId), eq(goals.companyId, input.companyId)))
            .then((rows) => rows[0] ?? null)
        : null;
      const report = projectRow.leadAgentId
        ? await db
            .select({
              issueId: issues.id,
              identifier: issues.identifier,
              body: documents.latestBody,
              updatedAt: documents.updatedAt,
              updatedByAgentId: documents.updatedByAgentId,
            })
            .from(issueDocuments)
            .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
            .innerJoin(issues, eq(issueDocuments.issueId, issues.id))
            .where(
              and(
                eq(issueDocuments.companyId, input.companyId),
                eq(issueDocuments.key, LEAD_REPORT_KEY),
                eq(issues.projectId, projectRow.id),
                isNull(issues.hiddenAt),
                eq(documents.updatedByAgentId, projectRow.leadAgentId),
              ),
            )
            .orderBy(desc(documents.updatedAt))
            .limit(1)
            .then((rows) => rows[0] ?? null)
        : null;
      const leadName = projectRow.leadAgentId
        ? (await namesFor(input.companyId, [], [projectRow.leadAgentId])).agents.get(projectRow.leadAgentId) ?? null
        : null;
      project = {
        id: projectRow.id,
        name: projectRow.name,
        lead: leadName,
        linkedGoal: goal
          ? {
              id: goal.id,
              title: goal.title,
              status: goal.status,
              ...(goal.metric
                ? {
                    metric: {
                      target: goal.metric.target,
                      unit: goal.metric.unit,
                      current: goal.metric.currentValue ?? null,
                      baseline: goal.metric.baseline ?? null,
                    },
                  }
                : {}),
            }
          : null,
        leadReport: report
          ? {
              author: leadName,
              kind: "agent_text" as const,
              agentWrote: true,
              recordedAt: report.updatedAt.toISOString(),
              ageMinutes: Math.max(0, Math.round((asOf.getTime() - report.updatedAt.getTime()) / 60_000)),
              excerpt: report.body.length > LEAD_REPORT_EXCERPT ? `${report.body.slice(0, LEAD_REPORT_EXCERPT - 1)}…` : report.body,
              issueRef: report.identifier ?? report.issueId,
            }
          : null,
        notes: [
          ...(goal ? [] : ["no goal linked"]),
          ...(report ? [] : ["no lead report on file"]),
        ],
      };
    }

    return {
      ...base,
      shipped,
      blockedNow,
      newlyBlocked,
      decisionsWaiting,
      scope: projectRow
        ? { type: "project" as const, company: company?.name ?? null, project: projectRow.name, projectId: projectRow.id }
        : { type: "company" as const, company: company?.name ?? null },
      changed,
      freshness,
      attention,
      briefing,
      ...(project ? { project } : {}),
    };
  }

  return { digest, audienceAgents, tasksAssignedTo, visibleProjectIds };
}

type RankedApproval = {
  approval: typeof approvals.$inferSelect;
  risk: ReturnType<typeof scopeAndRankOpenApprovals>[number]["risk"];
};

/** Issues with no project are company-visible; others need a visible project. */
function visibleIssueCondition(visible: ReadonlySet<string>) {
  const ids = [...visible];
  return ids.length ? or(isNull(issues.projectId), inArray(issues.projectId, ids))! : isNull(issues.projectId);
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
