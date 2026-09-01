import type { Request } from "express";
import { and, eq, exists, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { projectAccess, projects } from "@paperclipai/db";
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
 * The same question for a resource that hangs off a project (issue, cost
 * row). Null project id means company-visible.
 */
export async function assertProjectIdVisible(
  db: Db,
  req: Request,
  companyId: string,
  projectId: string | null | undefined,
  what = "Issue",
): Promise<void> {
  if (!projectId) return;
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
  if (!project) return; // dangling reference is not this guard's problem
  if (await isProjectVisible(db, req, project)) return;
  throw notFound(`${what} not found`);
}
