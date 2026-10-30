import type { Request } from "express";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentProfileRevisions, agentProfiles, agents, issueResponsibilities, issues } from "@paperclipai/db";
import {
  AGENT_PROFILE_UNKNOWN_RESPONSIBILITY,
  findProfileResponsibility,
  findResponsibilityByRoutineTrigger,
  profileResponsibilityKeys,
  type AgentOperatingProfileV1,
  type AgentProfileResponsibility,
  type IssueResponsibilityDto,
  type IssueResponsibilityMappedBy,
} from "@paperclipai/shared";
import { forbidden, notFound, unprocessable } from "../errors.js";
import { isCompanyAdministrator } from "../routes/authz.js";
import { accessService } from "./access.js";
import { insertActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { agentAccountabilityService } from "./agent-accountability.js";
import { agentStewardshipService } from "./agent-stewardships.js";

/**
 * AgentDash: Agent Performance Management gate 2 — which responsibility an
 * issue's work counts toward (evaluation LLD §5.2; gate 2 spec P2.4).
 *
 * `issue_responsibilities` is an append-only interval history: mapping closes
 * the current row (`valid_to`) and opens a new one in one transaction, and the
 * key must exist in the agent's ACTIVE profile (422
 * `AGENT_PROFILE_UNKNOWN_RESPONSIBILITY` otherwise). Activity:
 * `issue.responsibility_mapped`, in the same transaction as the row.
 *
 * The active revision is read directly from `agent_profiles` /
 * `agent_profile_revisions` (`resolveActiveProfileResponsibility`) rather than
 * through P2.2's service, so the two packages build in parallel.
 */

/**
 * Who maps. Allowed: the issue's assignee agent (to one of its own
 * responsibilities), the planner (Chief of Staff role), the agent's steward,
 * its accountable user, or a company admin; `system` is routine or
 * deliverable dispatch.
 */
export type ResponsibilityMappingActor =
  | { type: "agent"; agentId: string; runId?: string | null }
  | { type: "user"; userId: string; source?: string | null; isInstanceAdmin?: boolean }
  | { type: "system"; source: "routine" | "deliverable" };

export interface MapIssueResponsibilityInput {
  companyId: string;
  issueId: string;
  agentId: string;
  responsibilityKey: string;
  reason?: string | null;
  /** Defaults from the actor: agent → `agent` (or `planner` for the CoS), user → `human`, system → its source. */
  mappedBy?: IssueResponsibilityMappedBy;
}

export const RESPONSIBILITY_MAPPING_FORBIDDEN_MESSAGE =
  "Only the issue's assignee (for its own responsibilities), the Chief of Staff, the agent's steward or accountable person, or a company admin can map this issue.";

type IssueResponsibilityRow = typeof issueResponsibilities.$inferSelect;

function toDto(row: IssueResponsibilityRow): IssueResponsibilityDto {
  return {
    id: row.id,
    companyId: row.companyId,
    issueId: row.issueId,
    agentId: row.agentId,
    responsibilityKey: row.responsibilityKey,
    profileRevisionId: row.profileRevisionId ?? null,
    validFrom: row.validFrom.toISOString(),
    validTo: row.validTo ? row.validTo.toISOString() : null,
    mappedBy: row.mappedBy,
    mappedByActorId: row.mappedByActorId ?? null,
    reason: row.reason ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The agent's active revision, or null. Bodies are validated on the write
 * path; a stored body without a responsibilities array still reads as "no
 * responsibilities" rather than throwing inside a dispatch.
 */
async function loadActiveRevision(
  db: Db,
  scope: { companyId: string; agentId: string },
): Promise<{ id: string; body: AgentOperatingProfileV1 } | null> {
  const row = await db
    .select({ id: agentProfileRevisions.id, body: agentProfileRevisions.body })
    .from(agentProfiles)
    .innerJoin(agentProfileRevisions, eq(agentProfileRevisions.id, agentProfiles.activeRevisionId))
    .where(
      and(
        eq(agentProfiles.companyId, scope.companyId),
        eq(agentProfiles.agentId, scope.agentId),
        eq(agentProfileRevisions.companyId, scope.companyId),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!row) return null;
  const body = row.body as AgentOperatingProfileV1 | null;
  if (!body || !Array.isArray(body.responsibilities)) return { id: row.id, body: { ...(body ?? {}), responsibilities: [] } as AgentOperatingProfileV1 };
  return { id: row.id, body };
}

/** The responsibility `key` names in the agent's active profile, with the revision it came from; null when absent. Read-only. */
export async function resolveActiveProfileResponsibility(
  db: Db,
  scope: { companyId: string; agentId: string; responsibilityKey: string },
): Promise<{ profileRevisionId: string; responsibility: AgentProfileResponsibility } | null> {
  const active = await loadActiveRevision(db, scope);
  if (!active) return null;
  const responsibility = findProfileResponsibility(active.body, scope.responsibilityKey);
  return responsibility ? { profileRevisionId: active.id, responsibility } : null;
}

/**
 * The authority check, and the `mapped_by` it implies. Throws 403 otherwise.
 * An agent maps only as the issue's assignee and only to itself, unless it is
 * the company's Chief of Staff (the planner), which may map any issue.
 */
async function authorizeMapping(
  db: Db,
  scope: { companyId: string; agentId: string; issueAssigneeAgentId: string | null },
  actor: ResponsibilityMappingActor,
): Promise<IssueResponsibilityMappedBy> {
  if (actor.type === "system") return actor.source;
  if (actor.type === "agent") {
    if (actor.agentId === scope.agentId && scope.issueAssigneeAgentId === actor.agentId) return "agent";
    const self = await db
      .select({ role: agents.role, status: agents.status })
      .from(agents)
      .where(and(eq(agents.id, actor.agentId), eq(agents.companyId, scope.companyId)))
      .then((rows) => rows[0] ?? null);
    if (self && self.role === "chief_of_staff" && self.status !== "terminated") return "planner";
    throw forbidden(RESPONSIBILITY_MAPPING_FORBIDDEN_MESSAGE);
  }
  // The one administrator predicate (routes/authz.ts), asked of this user.
  const asRequest = {
    actor: { type: "board", userId: actor.userId, source: actor.source ?? undefined, isInstanceAdmin: actor.isInstanceAdmin === true },
  } as unknown as Request;
  if (await isCompanyAdministrator(accessService(db), asRequest, scope.companyId)) return "human";
  const [steward, accountable] = await Promise.all([
    agentStewardshipService(db).activeByAgent(scope.companyId, scope.agentId),
    agentAccountabilityService(db).resolveForAgent(scope.companyId, scope.agentId),
  ]);
  if (steward?.userId === actor.userId || (accountable?.userId != null && accountable.userId === actor.userId)) return "human";
  throw forbidden(RESPONSIBILITY_MAPPING_FORBIDDEN_MESSAGE);
}

function activityActor(actor: ResponsibilityMappingActor): {
  actorType: "agent" | "user" | "system";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  mappedByActorId: string | null;
} {
  if (actor.type === "agent") {
    return { actorType: "agent", actorId: actor.agentId, agentId: actor.agentId, runId: actor.runId ?? null, mappedByActorId: actor.agentId };
  }
  if (actor.type === "user") {
    return { actorType: "user", actorId: actor.userId, agentId: null, runId: null, mappedByActorId: actor.userId };
  }
  return { actorType: "system", actorId: `${actor.source}-dispatch`, agentId: null, runId: null, mappedByActorId: null };
}

/**
 * Close the current mapping and open the new one. Returns the new current row.
 * Mapping an issue to the responsibility it is already mapped to (same agent,
 * same key) writes nothing and returns the current row, so a repeated call —
 * a retried dispatch, an agent re-announcing its work — does not cut the
 * interval into slivers.
 */
export async function mapIssueResponsibility(
  db: Db,
  input: MapIssueResponsibilityInput,
  actor: ResponsibilityMappingActor,
): Promise<IssueResponsibilityDto> {
  const issue = await db
    .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId })
    .from(issues)
    .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
    .then((rows) => rows[0] ?? null);
  if (!issue) throw notFound("Issue not found");
  const agent = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
    .then((rows) => rows[0] ?? null);
  if (!agent) throw notFound("Agent not found");

  // Authority before the key: a caller who may not map learns nothing about the agent's profile.
  const defaultMappedBy = await authorizeMapping(
    db,
    { companyId: input.companyId, agentId: input.agentId, issueAssigneeAgentId: issue.assigneeAgentId ?? null },
    actor,
  );

  const active = await loadActiveRevision(db, { companyId: input.companyId, agentId: input.agentId });
  const responsibility = active ? findProfileResponsibility(active.body, input.responsibilityKey) : null;
  if (!active || !responsibility) {
    throw unprocessable(
      active
        ? `"${input.responsibilityKey}" is not a responsibility in the agent's active profile`
        : "The agent has no active operating profile, so no responsibility can be mapped yet",
      {
        code: AGENT_PROFILE_UNKNOWN_RESPONSIBILITY,
        agentId: input.agentId,
        responsibilityKey: input.responsibilityKey,
        availableKeys: active ? profileResponsibilityKeys(active.body) : [],
      },
    );
  }

  const mappedBy = input.mappedBy ?? defaultMappedBy;
  const who = activityActor(actor);
  const reason = input.reason?.trim() ? input.reason.trim() : null;

  const { row, publication } = await db.transaction(async (tx) => {
    // Serialize remaps of one issue; the partial unique index backs this.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`issue_responsibility:${input.issueId}`}, 0))`);
    const current = await tx
      .select()
      .from(issueResponsibilities)
      .where(
        and(
          eq(issueResponsibilities.companyId, input.companyId),
          eq(issueResponsibilities.issueId, input.issueId),
          isNull(issueResponsibilities.validTo),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (current && current.agentId === input.agentId && current.responsibilityKey === input.responsibilityKey) {
      return { row: current, publication: null as ActivityPublication | null };
    }
    const now = new Date();
    if (current) {
      await tx
        .update(issueResponsibilities)
        .set({ validTo: now })
        .where(and(eq(issueResponsibilities.id, current.id), isNull(issueResponsibilities.validTo)));
    }
    const [inserted] = await tx
      .insert(issueResponsibilities)
      .values({
        companyId: input.companyId,
        issueId: input.issueId,
        agentId: input.agentId,
        responsibilityKey: input.responsibilityKey,
        profileRevisionId: active.id,
        validFrom: now,
        validTo: null,
        mappedBy,
        mappedByActorId: who.mappedByActorId,
        reason,
      })
      .returning();
    const activity = await insertActivity(tx as unknown as Db, {
      companyId: input.companyId,
      actorType: who.actorType,
      actorId: who.actorId,
      action: "issue.responsibility_mapped",
      entityType: "issue",
      entityId: input.issueId,
      agentId: who.agentId,
      runId: who.runId,
      details: {
        mappingId: inserted!.id,
        agentId: input.agentId,
        responsibilityKey: input.responsibilityKey,
        responsibilityTitle: responsibility.title ?? null,
        profileRevisionId: active.id,
        mappedBy,
        reason,
        previous: current
          ? { mappingId: current.id, agentId: current.agentId, responsibilityKey: current.responsibilityKey }
          : null,
      },
    });
    return { row: inserted!, publication: activity };
  });
  if (publication) publishActivity(publication);
  return toDto(row);
}

/**
 * The current mapping (`valid_to IS NULL`), or null when the issue is unmapped.
 * Pass `companyId` unless the caller already checked the issue's company.
 */
export async function currentResponsibility(
  db: Db,
  issueId: string,
  options?: { companyId?: string },
): Promise<IssueResponsibilityDto | null> {
  const conditions = [eq(issueResponsibilities.issueId, issueId), isNull(issueResponsibilities.validTo)];
  if (options?.companyId) conditions.push(eq(issueResponsibilities.companyId, options.companyId));
  const row = await db
    .select()
    .from(issueResponsibilities)
    .where(and(...conditions))
    .then((rows) => rows[0] ?? null);
  return row ? toDto(row) : null;
}

/** Every interval for the issue, oldest first. Read-only. */
export async function responsibilityHistory(
  db: Db,
  scope: { companyId: string; issueId: string },
): Promise<IssueResponsibilityDto[]> {
  const rows = await db
    .select()
    .from(issueResponsibilities)
    .where(and(eq(issueResponsibilities.companyId, scope.companyId), eq(issueResponsibilities.issueId, scope.issueId)))
    .orderBy(asc(issueResponsibilities.validFrom), asc(issueResponsibilities.createdAt), asc(issueResponsibilities.id));
  return rows.map(toDto);
}

/**
 * The routine dispatch hook (`dispatchRoutineRun`): when the run's trigger is
 * bound to a responsibility in the assignee agent's active profile, map the
 * created issue to it (`mappedBy: "routine"`). Returns null, and writes
 * nothing, when the trigger is not bound. Must never fail the dispatch: an
 * error is logged and swallowed by the caller.
 */
export async function recordRoutineDispatchResponsibility(
  db: Db,
  input: { companyId: string; issueId: string; agentId: string; routineTriggerId: string },
): Promise<IssueResponsibilityDto | null> {
  const active = await loadActiveRevision(db, { companyId: input.companyId, agentId: input.agentId });
  if (!active) return null;
  const bound = findResponsibilityByRoutineTrigger(active.body, input.routineTriggerId);
  if (!bound) return null;
  return mapIssueResponsibility(
    db,
    {
      companyId: input.companyId,
      issueId: input.issueId,
      agentId: input.agentId,
      responsibilityKey: bound.key,
      mappedBy: "routine",
      reason: "Created by a routine trigger that this responsibility is bound to.",
    },
    { type: "system", source: "routine" },
  );
}
