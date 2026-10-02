import type { NextFunction, Request, Response } from "express";
import { and, eq, exists, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  approvals,
  budgetPolicies,
  agentStewardships,
  companies,
  executionWorkspaces,
  feedbackExports,
  heartbeatRuns,
  issues,
  projectAccess,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import { notFound } from "../errors.js";
import { actorHumanRole } from "./authz.js";

/**
 * A5 (2026-08-16): open by default, restriction per project.
 *
 * Every project is visible to every member of its company UNLESS
 * `projects.visibility = 'restricted'`, in which case it is visible to
 * admins, its creator, and the principals on its access list (which includes
 * the lead agent, added automatically when a project is restricted).
 *
 * ONE implementation of that sentence, composed into queries as SQL. A route
 * or service that filters projects any other way is wrong by definition —
 * the leak tests enumerate the read surfaces and hold them to this one.
 *
 * Invisible must mean NONEXISTENT: guards here throw 404, never 403. A 403
 * on a guessed id confirms the project exists, which is itself the leak.
 */

/**
 * A canonical, hyphenated UUID of any version, either case. Postgres also
 * accepts hyphenless and braced input for `uuid`, so a guard that skips
 * anything else while the route queries the raw value is a bypass; every
 * guard below answers 404 for any other form instead.
 */
const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CANONICAL_UUID_PATTERN = CANONICAL_UUID_RE.source;

export function isCanonicalUuid(value: unknown): boolean {
  return typeof value === "string" && CANONICAL_UUID_RE.test(value);
}

function actorPrincipal(req: Request): { type: "user" | "agent"; id: string } | null {
  if (req.actor.type === "agent" && req.actor.agentId) {
    return { type: "agent", id: req.actor.agentId };
  }
  if (req.actor.type === "board" && req.actor.userId) {
    return { type: "user", id: req.actor.userId };
  }
  return null;
}

/** Admins and instance operators see everything; the exception never applies. */
export function seesEverything(req: Request, companyId: string): boolean {
  if (req.actor.type === "board") {
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
    if (actorHumanRole(req, companyId) === "admin") return true;
  }
  return false;
}

/**
 * SQL condition over the `projects` table: which rows this actor may see.
 * Compose with company scoping — this answers visibility only.
 */
export function projectVisibilityCondition(req: Request, companyId: string): SQL | undefined {
  if (seesEverything(req, companyId)) return undefined; // no extra filter
  const principal = actorPrincipal(req);
  const open = eq(projects.visibility, "company");
  if (!principal) return open;
  const conditions: SQL[] = [open];
  if (principal.type === "user") {
    conditions.push(eq(projects.createdByUserId, principal.id));
  }
  conditions.push(
    exists(
      sql`(select 1 from ${projectAccess} where ${projectAccess.projectId} = ${projects.id}
           and ${projectAccess.principalType} = ${principal.type}
           and ${projectAccess.principalId} = ${principal.id})`,
    ),
  );
  return or(...conditions);
}

/**
 * SQL condition for any table carrying a nullable project id column:
 * rows with no project are company-visible; rows in a restricted project
 * follow the project rule.
 */
export function projectScopedVisibilityCondition(
  req: Request,
  companyId: string,
  projectIdColumn: SQL | { getSQL(): SQL },
): SQL | undefined {
  if (seesEverything(req, companyId)) return undefined;
  const principal = actorPrincipal(req);
  const col = projectIdColumn as unknown as SQL;
  const notRestricted = sql`not exists (select 1 from ${projects} p
      where p.id = ${col} and p.visibility = 'restricted')`;
  if (!principal) return or(isNull(col as never), notRestricted);
  const creator =
    principal.type === "user"
      ? sql`exists (select 1 from ${projects} p where p.id = ${col}
            and p.created_by_user_id = ${principal.id})`
      : sql`false`;
  const listed = sql`exists (select 1 from ${projectAccess} pa where pa.project_id = ${col}
        and pa.principal_type = ${principal.type} and pa.principal_id = ${principal.id})`;
  return or(isNull(col as never), notRestricted, creator, listed);
}

/**
 * Is this one project visible to this actor? For detail routes, where the
 * project row is already in hand.
 */
export async function isProjectVisible(
  db: Pick<Db, "select">,
  req: Request,
  project: { id: string; companyId: string; visibility?: string | null; createdByUserId?: string | null },
): Promise<boolean> {
  if (project.visibility !== "restricted") return true;
  if (seesEverything(req, project.companyId)) return true;
  const principal = actorPrincipal(req);
  if (!principal) return false;
  if (principal.type === "user" && project.createdByUserId === principal.id) return true;
  const row = await db
    .select({ projectId: projectAccess.projectId })
    .from(projectAccess)
    .where(
      and(
        eq(projectAccess.projectId, project.id),
        eq(projectAccess.principalType, principal.type),
        eq(projectAccess.principalId, principal.id),
      ),
    )
    .then((rows) => rows[0] ?? null);
  return Boolean(row);
}

/** 404, never 403 — invisible means nonexistent. */
export async function assertProjectVisible(
  db: Pick<Db, "select">,
  req: Request,
  project: { id: string; companyId: string; visibility?: string | null; createdByUserId?: string | null },
): Promise<void> {
  if (await isProjectVisible(db, req, project)) return;
  throw notFound("Project not found");
}

/**
 * Is the project with this id visible? Null or dangling means
 * company-visible; a non-canonical id is treated as invisible (fail closed).
 */
export async function isProjectIdVisible(
  db: Db,
  req: Request,
  projectId: string | null | undefined,
): Promise<boolean> {
  if (!projectId) return true;
  if (!isCanonicalUuid(projectId)) return false;
  const project = await db
    .select({
      id: projects.id,
      companyId: projects.companyId,
      visibility: projects.visibility,
      createdByUserId: projects.createdByUserId,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .then((rows) => rows[0] ?? null);
  if (!project) return true; // dangling reference is not this guard's problem
  return isProjectVisible(db, req, project);
}

/**
 * The same question for a resource that hangs off a project (issue, cost
 * row). Null project id means company-visible.
 */
export async function assertProjectIdVisible(
  db: Db,
  req: Request,
  _companyId: string,
  projectId: string | null | undefined,
  what = "Issue",
): Promise<void> {
  if (await isProjectIdVisible(db, req, projectId)) return;
  throw notFound(`${what} not found`);
}

/** Drop rows whose project the actor cannot see (one lookup per distinct project). */
export async function filterVisibleByProject<T extends { projectId: string | null }>(
  db: Db,
  req: Request,
  rows: T[],
): Promise<T[]> {
  const projectIds = [...new Set(rows.map((row) => row.projectId).filter((id): id is string => Boolean(id)))];
  const visible = new Map<string, boolean>();
  for (const projectId of projectIds) visible.set(projectId, await isProjectIdVisible(db, req, projectId));
  return rows.filter((row) => !row.projectId || visible.get(row.projectId) !== false);
}

/**
 * The same question for an issue known only by id (UUID or identifier such
 * as "PAP-39") — the guard behind every `/issues/:id/*` route. An issue in a
 * restricted project is nonexistent to an off-list actor, so its comments,
 * documents, attachments, work products, runs and mutations are too.
 * Unknown ids pass through (the route's own lookup answers 404); malformed
 * ids — anything but a canonical UUID or an identifier — are 404 here.
 */
export async function assertIssueIdVisible(
  db: Db,
  req: Request,
  issueRef: string | null | undefined,
  what = "Issue",
): Promise<void> {
  const ref = typeof issueRef === "string" ? issueRef.trim() : "";
  let match: SQL;
  if (isCanonicalUuid(ref)) match = eq(issues.id, ref);
  else if (/^[A-Z]+-\d+$/i.test(ref)) match = eq(issues.identifier, ref.toUpperCase());
  // Fail closed. Postgres also casts hyphenless and braced UUIDs, and some
  // routes query the raw param (the verdict routes did), so skipping here
  // let them find an issue this guard never looked at (GH #830 review).
  else throw notFound(`${what} not found`);
  const issue = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      projectId: projects.id,
      projectCompanyId: projects.companyId,
      projectVisibility: projects.visibility,
      projectCreatedByUserId: projects.createdByUserId,
    })
    .from(issues)
    .leftJoin(projects, eq(projects.id, issues.projectId))
    .where(match)
    .then((rows) => rows[0] ?? null);
  if (!issue) return; // no issue: the route's own lookup answers
  if (issue.projectId) {
    const visible = await isProjectVisible(db, req, {
      id: issue.projectId,
      companyId: issue.projectCompanyId ?? issue.companyId,
      visibility: issue.projectVisibility,
      createdByUserId: issue.projectCreatedByUserId,
    });
    if (!visible) throw notFound(`${what} not found`);
  }
  // Agent visibility (2026-09-30): the same predicate the list uses, asked
  // of this one row, so detail and list can never disagree.
  const scope = await resolveAgentVisibility(db, req, issue.companyId);
  if (scope.mode === "all") return;
  const allowed = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.id, issue.id), issueVisibilityCondition(req, issue.companyId)))
    .then((rows) => rows.length > 0);
  if (!allowed) throw notFound(`${what} not found`);
}

/**
 * `router.param(name, ...)` handler applying `assertIssueIdVisible` to every
 * route in a router that carries that issue-id param. Runs before the route
 * handler, so one registration covers the router's whole `/issues/:id/*`
 * surface, including routes added later.
 */
export function issueVisibilityParam(db: Db) {
  return async (req: Request, _res: Response, next: NextFunction, rawId: unknown) => {
    try {
      await assertIssueIdVisible(db, req, typeof rawId === "string" ? rawId : null);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * SQL for the project of the issue a heartbeat run works on
 * (`context_snapshot ->> 'issueId'`); NULL when the run has no issue.
 */
function runIssueProjectIdSql(): SQL {
  const ref = sql`(${heartbeatRuns.contextSnapshot} ->> 'issueId')`;
  return sql`(select i.project_id from ${issues} i where i.id =
    case when ${ref} ~* ${CANONICAL_UUID_PATTERN} then ${ref}::uuid end)`;
}

/**
 * SQL condition over `heartbeat_runs`: runs on an issue in a restricted
 * project vanish for an off-list actor, like the issue itself.
 */
export function runVisibilityCondition(req: Request, companyId: string): SQL | undefined {
  return projectScopedVisibilityCondition(req, companyId, runIssueProjectIdSql());
}

/**
 * A run's transcript, events and log carry its issue's content, so a run on
 * an invisible issue is itself nonexistent. Runs with no issue are
 * company-visible.
 */
export async function assertRunVisible(
  db: Db,
  req: Request,
  run: { contextSnapshot?: Record<string, unknown> | null },
  what = "Heartbeat run",
): Promise<void> {
  const issueId = run.contextSnapshot?.issueId;
  if (typeof issueId !== "string" || !isCanonicalUuid(issueId)) return;
  await assertIssueIdVisible(db, req, issueId, what);
}

/**
 * `router.param("runId", ...)` handler applying `assertRunVisible`. A
 * non-canonical run id is 404 (fail closed, as for issues).
 */
export function runVisibilityParam(db: Db) {
  return async (req: Request, _res: Response, next: NextFunction, rawId: unknown) => {
    try {
      if (typeof rawId !== "string" || !isCanonicalUuid(rawId)) throw notFound("Heartbeat run not found");
      const run = await db
        .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, rawId))
        .then((rows) => rows[0] ?? null);
      if (run) await assertRunVisible(db, req, run);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Workspace ids name a project too: an issue created or moved with only a
 * restricted project's workspace would run inside that project. Unknown ids
 * pass through to the service's own validation; non-canonical ids are 404.
 */
export async function assertWorkspaceIdsVisible(
  db: Db,
  req: Request,
  refs: { projectWorkspaceId?: unknown; executionWorkspaceId?: unknown },
): Promise<void> {
  if (typeof refs.projectWorkspaceId === "string") {
    if (!isCanonicalUuid(refs.projectWorkspaceId)) throw notFound("Project workspace not found");
    const row = await db
      .select({ projectId: projectWorkspaces.projectId })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.id, refs.projectWorkspaceId))
      .then((rows) => rows[0] ?? null);
    if (row && !(await isProjectIdVisible(db, req, row.projectId))) throw notFound("Project workspace not found");
  }
  if (typeof refs.executionWorkspaceId === "string") {
    if (!isCanonicalUuid(refs.executionWorkspaceId)) throw notFound("Execution workspace not found");
    const row = await db
      .select({ projectId: executionWorkspaces.projectId })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, refs.executionWorkspaceId))
      .then((rows) => rows[0] ?? null);
    if (row && !(await isProjectIdVisible(db, req, row.projectId))) throw notFound("Execution workspace not found");
  }
}

/**
 * SQL condition for the company activity feed (`activity_log` left-joined to
 * `issues` on issue rows): issue rows follow their issue's project, project
 * rows follow the project itself, and budget rows follow the project their
 * details' scope names; every other row is untouched.
 */
export function activityVisibilityCondition(req: Request, companyId: string): SQL | undefined {
  if (seesEverything(req, companyId)) return undefined;
  const projectEntityId = sql`(case when ${activityLog.entityType} = 'project'
      and ${activityLog.entityId} ~* ${CANONICAL_UUID_PATTERN} then ${activityLog.entityId}::uuid end)`;
  // AgentDash (GH #933): a project-scoped budget policy or incident carries
  // the project's id, name and spend in details — the row follows the
  // project rule, the same rule an approval's scope payload gets.
  const budgetScopeProjectId = sql`(case when ${activityLog.entityType} in ('budget_policy', 'budget_incident')
      and (${activityLog.details} ->> 'scopeType') = 'project'
      and (${activityLog.details} ->> 'scopeId') ~* ${CANONICAL_UUID_PATTERN}
      then (${activityLog.details} ->> 'scopeId')::uuid end)`;
  return and(
    projectScopedVisibilityCondition(req, companyId, issues.projectId),
    projectScopedVisibilityCondition(req, companyId, projectEntityId),
    projectScopedVisibilityCondition(req, companyId, budgetScopeProjectId),
  );
}

/**
 * AgentDash (GH #902): SQL condition over `budget_policies`. Only a
 * project-scoped policy carries a project id; company and agent scopes yield
 * NULL and stay company-visible.
 */
export function budgetPolicyVisibilityCondition(req: Request, companyId: string): SQL | undefined {
  return projectScopedVisibilityCondition(
    req,
    companyId,
    sql`(case when ${budgetPolicies.scopeType} = 'project' then ${budgetPolicies.scopeId} end)`,
  );
}

/**
 * AgentDash (GH #902): the project a `budget_override_required` approval is
 * about, from its payload; null for every other approval and every other
 * budget scope.
 */
export function approvalBudgetProjectId(approval: { type: string; payload: unknown }): string | null {
  if (approval.type !== "budget_override_required") return null;
  const payload = (approval.payload ?? {}) as Record<string, unknown>;
  if (payload.scopeType !== "project") return null;
  return typeof payload.scopeId === "string" ? payload.scopeId : null;
}

/**
 * AgentDash (GH #902): SQL condition over `approvals`. A
 * `budget_override_required` approval carries the scope's name, id and
 * observed spend in its payload, so for a project scope it follows the
 * project rule; every other approval is untouched.
 */
export function approvalVisibilityCondition(req: Request, companyId: string): SQL | undefined {
  const ref = sql`(${approvals.payload} ->> 'scopeId')`;
  const budgetProjectId = sql`(case when ${approvals.type} = 'budget_override_required'
      and (${approvals.payload} ->> 'scopeType') = 'project'
      and ${ref} ~* ${CANONICAL_UUID_PATTERN} then ${ref}::uuid end)`;
  return projectScopedVisibilityCondition(req, companyId, budgetProjectId);
}

/** AgentDash (GH #902): 404, never 403, for an approval about a hidden project. */
export async function assertApprovalProjectVisible(
  db: Db,
  req: Request,
  approval: { companyId: string; type: string; payload: unknown },
): Promise<void> {
  await assertProjectIdVisible(db, req, approval.companyId, approvalBudgetProjectId(approval), "Approval");
}

/**
 * Which of these issue ids may this actor see? Returns the visible subset;
 * ids that are malformed, missing, in another company, or in a restricted
 * project the actor is off the list for are all absent from the result.
 * One query, whatever the size of the input.
 */
export async function listVisibleIssueIds(
  db: Db,
  req: Request,
  companyId: string,
  issueIds: Iterable<string>,
): Promise<Set<string>> {
  const ids = [...new Set([...issueIds].filter((id) => isCanonicalUuid(id)))];
  if (ids.length === 0) return new Set();
  const visibility = projectScopedVisibilityCondition(req, companyId, issues.projectId);
  const rows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, ids), visibility));
  return new Set(rows.map((row) => row.id));
}

/**
 * Body-supplied issue-id arrays (`blockedByIssueIds`): every id must name an
 * issue in this company that the actor can see. Missing, foreign and
 * restricted ids get the SAME 404, so the answer is not an existence oracle
 * for a restricted issue's UUID (GH #830 follow-up).
 */
export async function assertIssueIdsVisibleInCompany(
  db: Db,
  req: Request,
  companyId: string,
  issueIds: unknown,
  what = "Blocker issue",
): Promise<void> {
  if (!Array.isArray(issueIds) || issueIds.length === 0) return;
  const refs = [...new Set(issueIds as unknown[])];
  if (!refs.every((ref) => isCanonicalUuid(ref))) throw notFound(`${what} not found`);
  const visible = await listVisibleIssueIds(db, req, companyId, refs as string[]);
  if (visible.size !== refs.length) throw notFound(`${what} not found`);
}

interface RelatedIssueRef {
  id: string;
  terminalBlockers?: RelatedIssueRef[];
}

function collectRelatedIssueIds(entries: readonly RelatedIssueRef[], into: Set<string>) {
  for (const entry of entries) {
    into.add(entry.id);
    if (entry.terminalBlockers) collectRelatedIssueIds(entry.terminalBlockers, into);
  }
}

function pruneRelatedIssues<E extends RelatedIssueRef>(entries: readonly E[], visible: Set<string>): E[] {
  return entries
    .filter((entry) => visible.has(entry.id))
    .map((entry) =>
      entry.terminalBlockers
        ? ({ ...entry, terminalBlockers: pruneRelatedIssues(entry.terminalBlockers, visible) } as E)
        : entry,
    );
}

/**
 * blockedBy / blocks summaries carry the related issue's identifier, title,
 * status and assignees. A related issue the actor cannot see is omitted
 * entirely — including from nested `terminalBlockers` — as if the relation
 * did not exist.
 */
export async function filterVisibleIssueRelations<
  E extends RelatedIssueRef,
  T extends { blockedBy: E[]; blocks: E[] },
>(db: Db, req: Request, companyId: string, relations: T): Promise<T> {
  if (seesEverything(req, companyId)) return relations;
  const ids = new Set<string>();
  collectRelatedIssueIds(relations.blockedBy, ids);
  collectRelatedIssueIds(relations.blocks, ids);
  if (ids.size === 0) return relations;
  const visible = await listVisibleIssueIds(db, req, companyId, ids);
  return {
    ...relations,
    blockedBy: pruneRelatedIssues(relations.blockedBy, visible),
    blocks: pruneRelatedIssues(relations.blocks, visible),
  };
}

/** The same rule over list rows that each carry an optional `blockedBy`. */
export async function filterVisibleBlockedByOnRows<R extends object>(
  db: Db,
  req: Request,
  companyId: string,
  rows: R[],
): Promise<R[]> {
  if (seesEverything(req, companyId)) return rows;
  const blockedByOf = (row: R) => (row as { blockedBy?: RelatedIssueRef[] }).blockedBy;
  const ids = new Set<string>();
  for (const row of rows) {
    const blockedBy = blockedByOf(row);
    if (Array.isArray(blockedBy)) collectRelatedIssueIds(blockedBy, ids);
  }
  if (ids.size === 0) return rows;
  const visible = await listVisibleIssueIds(db, req, companyId, ids);
  return rows.map((row) => {
    const blockedBy = blockedByOf(row);
    return Array.isArray(blockedBy) ? { ...row, blockedBy: pruneRelatedIssues(blockedBy, visible) } : row;
  });
}

/**
 * Ancestor chains (nearest parent first) stop at the first ancestor the
 * actor cannot see. Anything above it is reachable only through the hidden
 * link, and skipping over it would leave a gap that confirms the hidden
 * issue; the chain reads as if the visible part were the whole hierarchy.
 */
export async function truncateAncestorsAtInvisible<A extends { id: string }>(
  db: Db,
  req: Request,
  companyId: string,
  ancestors: A[],
): Promise<A[]> {
  if (ancestors.length === 0 || seesEverything(req, companyId)) return ancestors;
  const visible = await listVisibleIssueIds(
    db,
    req,
    companyId,
    ancestors.map((ancestor) => ancestor.id),
  );
  const firstHidden = ancestors.findIndex((ancestor) => !visible.has(ancestor.id));
  return firstHidden === -1 ? ancestors : ancestors.slice(0, firstHidden);
}

interface BlockerAttentionSamples {
  sampleBlockerIdentifier: string | null;
  sampleStalledBlockerIdentifier: string | null;
}

interface IssueRefsOnRow {
  parentId?: string | null;
  blockerAttention?: BlockerAttentionSamples | null;
}

/**
 * AgentDash (GH #863, #868 follow-up): the references a visible issue makes
 * to OTHER issues outside its relation summaries.
 *
 * - `parentId`: a restricted parent's UUID is dropped (null), matching the
 *   ancestor chain, which already stops at the first invisible ancestor.
 * - `blockerAttention.sample*Identifier`: computed over the whole blocker
 *   graph before any filtering, so it can name a restricted blocker anywhere
 *   down the chain. A sample naming an issue the actor cannot see (or one
 *   that no longer resolves in this company) is nulled. The counts and the
 *   state stay: they describe whether this issue is really unblocked, which
 *   its own status already says, and name nothing.
 */
export async function redactHiddenIssueRefsOnRows<R extends IssueRefsOnRow>(
  db: Db,
  req: Request,
  companyId: string,
  rows: R[],
): Promise<R[]> {
  if (rows.length === 0 || seesEverything(req, companyId)) return rows;
  const parentIds = new Set<string>();
  const sampleRefs = new Set<string>();
  for (const row of rows) {
    if (typeof row.parentId === "string") parentIds.add(row.parentId);
    const attention = row.blockerAttention;
    if (attention?.sampleBlockerIdentifier) sampleRefs.add(attention.sampleBlockerIdentifier);
    if (attention?.sampleStalledBlockerIdentifier) sampleRefs.add(attention.sampleStalledBlockerIdentifier);
  }
  if (parentIds.size === 0 && sampleRefs.size === 0) return rows;

  // Samples are identifiers (`ACME-12`), or a bare id when the blocker has none.
  const sampleIdentifiers = [...sampleRefs].filter((ref) => !isCanonicalUuid(ref));
  const idByRef = new Map<string, string>();
  for (const ref of sampleRefs) if (isCanonicalUuid(ref)) idByRef.set(ref, ref);
  if (sampleIdentifiers.length > 0) {
    const resolved = await db
      .select({ id: issues.id, identifier: issues.identifier })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.identifier, sampleIdentifiers)));
    for (const row of resolved) if (row.identifier) idByRef.set(row.identifier, row.id);
  }
  const visible = await listVisibleIssueIds(db, req, companyId, [...parentIds, ...idByRef.values()]);
  const sampleVisible = (ref: string | null) => {
    if (!ref) return ref;
    const id = idByRef.get(ref);
    return id && visible.has(id) ? ref : null;
  };

  return rows.map((row) => {
    let next = row;
    if (typeof row.parentId === "string" && !visible.has(row.parentId)) {
      next = { ...next, parentId: null };
    }
    const attention = row.blockerAttention;
    if (attention) {
      const sampleBlockerIdentifier = sampleVisible(attention.sampleBlockerIdentifier);
      const sampleStalledBlockerIdentifier = sampleVisible(attention.sampleStalledBlockerIdentifier);
      if (
        sampleBlockerIdentifier !== attention.sampleBlockerIdentifier
        || sampleStalledBlockerIdentifier !== attention.sampleStalledBlockerIdentifier
      ) {
        next = { ...next, blockerAttention: { ...attention, sampleBlockerIdentifier, sampleStalledBlockerIdentifier } };
      }
    }
    return next;
  });
}

/**
 * AgentDash (GH #863, #868 follow-up): activity details that name OTHER
 * issues. `issue.blockers_updated` stores each blocker's id, identifier and
 * title, and `issue.updated` / `issue.created` store referenced issues the
 * same way. Activity rows are filtered by the issue they are ABOUT, so a
 * visible issue's row could still carry a restricted blocker's title. These
 * keys are pruned to the issues the reader can see, read-side, because a row
 * is written once and read by people with different access.
 */
const ACTIVITY_ISSUE_SUMMARY_KEYS = [
  "blockedByIssues",
  "addedBlockedByIssues",
  "removedBlockedByIssues",
  "addedReferencedIssues",
  "removedReferencedIssues",
  "currentReferencedIssues",
] as const;
const ACTIVITY_ISSUE_ID_KEYS = ["blockedByIssueIds", "addedBlockedByIssueIds", "removedBlockedByIssueIds"] as const;

function asDetailsRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Every issue id named under the related-issue keys of one activity `details`. */
export function relatedIssueIdsInActivityDetails(details: unknown): string[] {
  const record = asDetailsRecord(details);
  if (!record) return [];
  const ids = new Set<string>();
  for (const key of ACTIVITY_ISSUE_SUMMARY_KEYS) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      const id = asDetailsRecord(entry)?.id;
      if (typeof id === "string") ids.add(id);
    }
  }
  for (const key of ACTIVITY_ISSUE_ID_KEYS) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    for (const id of value) if (typeof id === "string") ids.add(id);
  }
  // `issue.updated` keeps the previous values (e.g. the old blocker ids) under _previous.
  if (asDetailsRecord(record._previous)) {
    for (const id of relatedIssueIdsInActivityDetails(record._previous)) ids.add(id);
  }
  return [...ids];
}

/**
 * The same `details` with related-issue entries the reader cannot see
 * removed. Returns the input object unchanged when nothing is hidden.
 */
export function pruneRelatedIssuesInActivityDetails<D>(details: D, visible: (issueId: string) => boolean): D {
  const record = asDetailsRecord(details);
  if (!record) return details;
  let next: Record<string, unknown> | null = null;
  for (const key of ACTIVITY_ISSUE_SUMMARY_KEYS) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    const kept = value.filter((entry) => {
      const id = asDetailsRecord(entry)?.id;
      return typeof id === "string" && visible(id);
    });
    if (kept.length !== value.length) (next ??= { ...record })[key] = kept;
  }
  for (const key of ACTIVITY_ISSUE_ID_KEYS) {
    const value = record[key];
    if (!Array.isArray(value)) continue;
    const kept = value.filter((id) => typeof id === "string" && visible(id));
    if (kept.length !== value.length) (next ??= { ...record })[key] = kept;
  }
  if (asDetailsRecord(record._previous)) {
    const previous = pruneRelatedIssuesInActivityDetails(record._previous, visible);
    if (previous !== record._previous) (next ??= { ...record })._previous = previous;
  }
  return (next ?? details) as D;
}

/** REST read side: prune related issues in each activity row's `details`. */
export async function redactHiddenIssuesInActivityRows<R extends { details?: unknown }>(
  db: Db,
  req: Request,
  companyId: string,
  rows: R[],
): Promise<R[]> {
  if (rows.length === 0 || seesEverything(req, companyId)) return rows;
  const ids = new Set<string>();
  for (const row of rows) for (const id of relatedIssueIdsInActivityDetails(row.details)) ids.add(id);
  if (ids.size === 0) return rows;
  const visible = await listVisibleIssueIds(db, req, companyId, ids);
  return rows.map((row) => {
    const details = pruneRelatedIssuesInActivityDetails(row.details, (id) => visible.has(id));
    return details === row.details ? row : { ...row, details };
  });
}

/** "Related work" (issue mentions, both directions) follows the same rule. */
export async function filterVisibleReferenceSummary<
  I extends { issue: { id: string } },
  S extends { outbound: I[]; inbound: I[] },
>(db: Db, req: Request, companyId: string, summary: S): Promise<S> {
  if (seesEverything(req, companyId)) return summary;
  const ids = [...summary.outbound, ...summary.inbound].map((item) => item.issue.id);
  if (ids.length === 0) return summary;
  const visible = await listVisibleIssueIds(db, req, companyId, ids);
  return {
    ...summary,
    outbound: summary.outbound.filter((item) => visible.has(item.issue.id)),
    inbound: summary.inbound.filter((item) => visible.has(item.issue.id)),
  };
}

/**
 * SQL condition over `feedback_exports` joined to `issues`: a trace follows
 * its issue's current project AND the project recorded on the trace, so a
 * trace captured while the issue sat in a restricted project stays hidden
 * after the issue moves out (its payload was captured there).
 */
export function feedbackTraceVisibilityCondition(req: Request, companyId: string): SQL | undefined {
  if (seesEverything(req, companyId)) return undefined;
  return and(
    projectScopedVisibilityCondition(req, companyId, issues.projectId),
    projectScopedVisibilityCondition(req, companyId, feedbackExports.projectId),
  );
}

/** Single-trace fetches: a trace on an invisible issue or project is 404. */
export async function assertFeedbackTraceVisible(
  db: Db,
  req: Request,
  trace: { issueId: string; projectId: string | null },
): Promise<void> {
  await assertIssueIdVisible(db, req, trace.issueId, "Feedback trace");
  await assertProjectIdVisible(db, req, "", trace.projectId, "Feedback trace");
}

/* ------------------------------------------------------------------------ */
/* Agent visibility (2026-09-30): members see the agents they answer for.    */
/* ------------------------------------------------------------------------ */

/**
 * A second visibility rule, built to the same sentence as A5 and composed the
 * same way: SQL into every list, 404 on every id route, admins exempt.
 *
 * Each agent resolves to 'company' or 'owner' — its own `agents.visibility`
 * if set, else `companies.agent_visibility_default`. A 'company' agent is
 * visible to every member. An 'owner' agent is visible to a member when:
 *   - they answer for it (active stewardship, or `accountable_user_id`), or
 *   - it reports, transitively, to an agent they answer for, or
 *   - they created it.
 * Admins, instance operators and the local board see everything. Agent
 * actors are NOT subject to this rule: agents keep full org visibility (the
 * spec's default), and A5 keeps governing them as before.
 *
 * The set is resolved once per request and cached on the request, because a
 * list route composes several conditions synchronously (as `visibleWhere`)
 * and the resolution needs one recursive query. `resolveAgentVisibility`
 * must run before any condition below is built; building one without it is
 * a wiring mistake and throws, rather than silently filtering nothing.
 *
 * The company default decides what an unattributed ISSUE means to a member:
 *   - default 'owner'  : a member sees the issues attributed to a visible
 *                        agent, their own issues, and every issue in a project
 *                        they are listed on or created. Nothing else.
 *   - default 'company': everything as today, minus issues attributed to an
 *                        agent an admin marked 'owner'.
 * Both compose with A5; the project rule is never relaxed.
 */
export type AgentVisibility = "company" | "owner";

export type AgentVisibilityScope =
  | { mode: "all" }
  | { mode: "owner"; userId: string; companyDefault: AgentVisibility; visibleAgentIds: ReadonlySet<string> };

const agentVisibilityScopes = new WeakMap<object, Map<string, AgentVisibilityScope>>();

function cachedScope(req: Request, companyId: string): AgentVisibilityScope | undefined {
  return agentVisibilityScopes.get(req)?.get(companyId);
}

function rememberScope(req: Request, companyId: string, scope: AgentVisibilityScope): AgentVisibilityScope {
  let perCompany = agentVisibilityScopes.get(req);
  if (!perCompany) {
    perCompany = new Map();
    agentVisibilityScopes.set(req, perCompany);
  }
  perCompany.set(companyId, scope);
  return scope;
}

/**
 * True when the actor sees every agent in every company it can reach, which
 * is decidable from the request alone: agent actors, the local board,
 * instance admins, and humans who are admins in each of their memberships.
 * Lets the id guard skip the database for the common case — and lets the
 * stub-database route suites that run as admins keep running unchanged.
 */
function plainlySeesAllAgents(req: Request): boolean {
  if (req.actor.type !== "board" || !req.actor.userId) return true;
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
  const memberships = Array.isArray(req.actor.memberships) ? req.actor.memberships : [];
  return memberships.length > 0 && memberships.every((m) => actorHumanRole(req, m.companyId) === "admin");
}

/** The human board actors the rule applies to; everyone else sees all agents. */
function restrictedHumanUserId(req: Request, companyId: string): string | null {
  if (req.actor.type !== "board" || !req.actor.userId) return null;
  if (seesEverything(req, companyId)) return null;
  return req.actor.userId;
}

/**
 * Resolve, once per request, which agents of this company the actor may see.
 * Cheap when nothing is restricted: one indexed existence check decides that
 * the rule has nothing to do, and no set is built.
 */
export async function resolveAgentVisibility(
  db: Pick<Db, "select" | "execute">,
  req: Request,
  companyId: string,
): Promise<AgentVisibilityScope> {
  const cached = cachedScope(req, companyId);
  if (cached) return cached;

  const userId = restrictedHumanUserId(req, companyId);
  if (!userId || plainlySeesAllAgents(req)) return rememberScope(req, companyId, { mode: "all" });

  const company = await db
    .select({ agentVisibilityDefault: companies.agentVisibilityDefault })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  const companyDefault: AgentVisibility = company?.agentVisibilityDefault === "owner" ? "owner" : "company";

  if (companyDefault === "company") {
    const anyOwnerOnly = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.visibility, "owner")))
      .limit(1)
      .then((rows) => rows.length > 0);
    if (!anyOwnerOnly) return rememberScope(req, companyId, { mode: "all" });
  }

  // One query. `answers_for` is the agents this person stewards or is
  // accountable for; `line` walks reports_to downward from those only — an
  // 'owner' agent reporting to a shared one must not become visible through
  // the shared one. Created and effectively-'company' agents are added flat.
  const rows = await db.execute<{ id: string }>(sql`
    with recursive answers_for as (
      select a.id from ${agents} a
      where a.company_id = ${companyId}
        and (
          a.accountable_user_id = ${userId}
          or exists (
            select 1 from ${agentStewardships} s
            where s.company_id = ${companyId} and s.agent_id = a.id
              and s.user_id = ${userId} and s.ended_at is null
          )
        )
    ),
    line as (
      select id from answers_for
      union
      select a.id from ${agents} a join line on a.reports_to = line.id
      where a.company_id = ${companyId}
    )
    select id from line
    union
    select a.id from ${agents} a
    where a.company_id = ${companyId}
      and (
        a.created_by_user_id = ${userId}
        or coalesce(a.visibility, ${companyDefault}) = 'company'
      )
  `);
  const ids = new Set<string>();
  for (const row of rows as unknown as Iterable<{ id: string }>) ids.add(row.id);
  return rememberScope(req, companyId, { mode: "owner", userId, companyDefault, visibleAgentIds: ids });
}

function requireScope(req: Request, companyId: string): AgentVisibilityScope {
  const scope = cachedScope(req, companyId);
  if (!scope) {
    throw new Error(
      "agent visibility: resolveAgentVisibility(db, req, companyId) must run before a condition is built",
    );
  }
  return scope;
}

function inVisibleSet(col: SQL, ids: ReadonlySet<string>): SQL {
  return ids.size === 0 ? sql`false` : inArray(col as never, [...ids]);
}

/**
 * SQL condition for any table carrying an agent id column: rows about an
 * agent the actor cannot see vanish. A NULL agent column is not about any
 * agent and passes. `undefined` when the actor sees every agent.
 */
export function agentVisibilityCondition(
  req: Request,
  companyId: string,
  agentIdColumn: SQL | { getSQL(): SQL },
): SQL | undefined {
  const scope = requireScope(req, companyId);
  if (scope.mode === "all") return undefined;
  const col = agentIdColumn as unknown as SQL;
  return or(isNull(col as never), inVisibleSet(col, scope.visibleAgentIds));
}

/**
 * SQL condition over `issues` composing A5 with the agent rule — see the
 * module comment for what the company default means for unattributed issues.
 */
export function issueVisibilityCondition(req: Request, companyId: string): SQL | undefined {
  const project = projectScopedVisibilityCondition(req, companyId, issues.projectId);
  const scope = requireScope(req, companyId);
  if (scope.mode === "all") return project;
  const ids = scope.visibleAgentIds;
  if (scope.companyDefault === "company") {
    return and(
      project,
      or(isNull(issues.assigneeAgentId), inVisibleSet(issues.assigneeAgentId as unknown as SQL, ids)),
      or(isNull(issues.createdByAgentId), inVisibleSet(issues.createdByAgentId as unknown as SQL, ids)),
    );
  }
  const attributed = or(
    inVisibleSet(issues.assigneeAgentId as unknown as SQL, ids),
    inVisibleSet(issues.createdByAgentId as unknown as SQL, ids),
  );
  const mine = or(eq(issues.assigneeUserId, scope.userId), eq(issues.createdByUserId, scope.userId));
  const listedProject = sql`exists (select 1 from ${projects} p
      where p.id = ${issues.projectId} and (
        p.created_by_user_id = ${scope.userId}
        or exists (select 1 from ${projectAccess} pa where pa.project_id = p.id
            and pa.principal_type = 'user' and pa.principal_id = ${scope.userId})))`;
  return and(project, or(attributed, mine, listedProject));
}

/** Which of these agent ids may this actor see? Null means all of them. */
export async function visibleAgentIdsFor(
  db: Pick<Db, "select" | "execute">,
  req: Request,
  companyId: string,
): Promise<ReadonlySet<string> | null> {
  const scope = await resolveAgentVisibility(db, req, companyId);
  return scope.mode === "all" ? null : scope.visibleAgentIds;
}

/**
 * The guard behind every `/agents/:id/*` route: an agent the actor cannot
 * see is nonexistent, so its detail, configuration, runs, memory and
 * stewardship are too. Unknown ids pass through (the route answers 404);
 * non-canonical ids are 404 here, as for issues.
 */

export async function assertAgentIdVisible(
  db: Db,
  req: Request,
  agentId: string | null | undefined,
  what = "Agent",
): Promise<void> {
  const id = typeof agentId === "string" ? agentId.trim() : "";
  if (!isCanonicalUuid(id)) throw notFound(`${what} not found`);
  if (plainlySeesAllAgents(req)) return;
  const agent = await db
    .select({ id: agents.id, companyId: agents.companyId })
    .from(agents)
    .where(eq(agents.id, id))
    .then((rows) => rows[0] ?? null);
  if (!agent) return;
  const scope = await resolveAgentVisibility(db, req, agent.companyId);
  if (scope.mode === "all" || scope.visibleAgentIds.has(agent.id)) return;
  throw notFound(`${what} not found`);
}

/** `router.param(name, ...)` handler applying `assertAgentIdVisible`. */
export function agentVisibilityParam(db: Db) {
  return async (req: Request, _res: Response, next: NextFunction, rawId: unknown) => {
    try {
      await assertAgentIdVisible(db, req, typeof rawId === "string" ? rawId : null);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * An org tree for a member who cannot see every agent: invisible nodes are
 * removed and their visible reports take their place in the parent's list,
 * so the shape a person sees is "the agents I can see, in their lines", not
 * a tree with holes that confirm what was cut out.
 */
export function pruneOrgTreeToVisible(
  nodes: readonly Record<string, unknown>[],
  visible: ReadonlySet<string>,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const node of nodes) {
    const children = Array.isArray(node.reports) ? (node.reports as Record<string, unknown>[]) : [];
    const reports = pruneOrgTreeToVisible(children, visible);
    if (typeof node.id === "string" && visible.has(node.id)) out.push({ ...node, reports });
    else out.push(...reports);
  }
  return out;
}
