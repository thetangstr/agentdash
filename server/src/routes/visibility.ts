import type { NextFunction, Request, Response } from "express";
import { and, eq, exists, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  executionWorkspaces,
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
  db: Db,
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
  db: Db,
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
  const row = await db
    .select({
      id: projects.id,
      companyId: projects.companyId,
      visibility: projects.visibility,
      createdByUserId: projects.createdByUserId,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(match)
    .then((rows) => rows[0] ?? null);
  if (!row) return; // no issue, or no project: company-visible
  if (await isProjectVisible(db, req, row)) return;
  throw notFound(`${what} not found`);
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
 * rows follow the project itself; every other row is untouched.
 */
export function activityVisibilityCondition(req: Request, companyId: string): SQL | undefined {
  if (seesEverything(req, companyId)) return undefined;
  const projectEntityId = sql`(case when ${activityLog.entityType} = 'project'
      and ${activityLog.entityId} ~* ${CANONICAL_UUID_PATTERN} then ${activityLog.entityId}::uuid end)`;
  return and(
    projectScopedVisibilityCondition(req, companyId, issues.projectId),
    projectScopedVisibilityCondition(req, companyId, projectEntityId),
  );
}
