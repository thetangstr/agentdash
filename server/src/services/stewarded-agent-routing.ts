import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Request } from "express";
import type { Db } from "@paperclipai/db";
import { visibleAgentIdsFor } from "../routes/visibility.js";
import { activityLog, agents, agentStewardships } from "@paperclipai/db";
import {
  evaluateAgentHarnessPreflightReadiness,
  shouldRequireAgentHarnessPreflight,
} from "./agent-harness-preflight-readiness.js";

/**
 * AgentDash: work assigned to a person who stewards an agent goes to that agent.
 *
 * People remember names, not agents. Whoever assigns an issue to a colleague —
 * a person or an agent — the agent that colleague stewards takes the first
 * pass, and decides from its own mandate whether its steward is needed.
 *
 * The person keeps the assignment when:
 *  - the caller set `assignToPerson: true` (any caller may keep it with them);
 *  - the caller is that person (they are taking the work themselves);
 *  - an agent is named as well (the caller already chose);
 *  - the person stewards no agent, or their agent is the caller (that is the
 *    agent handing work to its own steward; routing it back would loop);
 *  - their agent cannot take work right now (paused, terminated, pending
 *    approval, in error, or a harness that is not ready) — the work would sit
 *    unseen, which is worse than a decision item the person will see.
 * The route adds the cases that need the request: an agent the caller cannot
 * see, a reviewer or approver named by the issue's execution policy, and on
 * an update the person already holding the issue or an issue returned to its
 * creator.
 */
export interface StewardedAgentRoute {
  fromUserId: string;
  toAgentId: string;
}

const NOT_ROUTABLE_AGENT_STATUSES = new Set(["paused", "terminated", "pending_approval", "error"]);

/**
 * The harness readiness the agent's page reports (`harnessReadiness`). Saved
 * evidence that the harness failed against the current configuration always
 * blocks routing; missing or stale evidence blocks it only where the instance
 * requires a preflight before an agent runs, the same gate a launch uses.
 */
function harnessCanTakeWork(agent: {
  adapterType: string;
  adapterConfig: unknown;
  defaultEnvironmentId: string | null;
  metadata: unknown;
}): boolean {
  const readiness = evaluateAgentHarnessPreflightReadiness({
    adapterType: agent.adapterType,
    adapterConfig:
      agent.adapterConfig && typeof agent.adapterConfig === "object" && !Array.isArray(agent.adapterConfig)
        ? (agent.adapterConfig as Record<string, unknown>)
        : {},
    defaultEnvironmentId: agent.defaultEnvironmentId,
    metadata: agent.metadata ?? null,
  });
  if (readiness.ready) return true;
  if (readiness.reason === "not_passed") return false;
  return !shouldRequireAgentHarnessPreflight();
}

export async function resolveStewardedAgentRoute(
  db: Pick<Db, "select">,
  input: {
    companyId: string;
    /** The calling agent, or null when the caller is not an agent. */
    actorAgentId: string | null;
    /** The calling person, or null when the caller is not a person. */
    actorUserId?: string | null;
    assigneeAgentId?: string | null;
    assigneeUserId?: string | null;
    assignToPerson?: boolean;
  },
): Promise<StewardedAgentRoute | null> {
  if (input.assignToPerson === true || input.assigneeAgentId) return null;
  const userId = typeof input.assigneeUserId === "string" ? input.assigneeUserId.trim() : "";
  if (!userId) return null;
  if (input.actorUserId && input.actorUserId === userId) return null;
  const row = await db
    .select({
      agentId: agents.id,
      status: agents.status,
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
      defaultEnvironmentId: agents.defaultEnvironmentId,
      metadata: agents.metadata,
    })
    .from(agentStewardships)
    .innerJoin(agents, eq(agents.id, agentStewardships.agentId))
    .where(
      and(
        eq(agentStewardships.companyId, input.companyId),
        eq(agentStewardships.userId, userId),
        eq(agents.companyId, input.companyId),
        isNull(agentStewardships.endedAt),
      ),
    )
    .then((rows) => rows[0] ?? null);
  if (!row || (input.actorAgentId && row.agentId === input.actorAgentId) || NOT_ROUTABLE_AGENT_STATUSES.has(row.status)) return null;
  if (!harnessCanTakeWork(row)) return null;
  return { fromUserId: userId, toAgentId: row.agentId };
}

/**
 * AgentDash: is `userId` the active steward of `agentId`? An agent handing its
 * own issue to its own steward ("my steward must do this themselves") is the
 * other half of the routing above — the steward's work comes to the agent, and
 * the agent can always give it back — so, like returning an issue to the
 * person who created it, it needs no `tasks:assign`.
 */
export async function isActiveStewardOf(
  db: Pick<Db, "select">,
  input: { companyId: string; agentId: string; userId: string },
): Promise<boolean> {
  const row = await db
    .select({ agentId: agentStewardships.agentId })
    .from(agentStewardships)
    .where(
      and(
        eq(agentStewardships.companyId, input.companyId),
        eq(agentStewardships.agentId, input.agentId),
        eq(agentStewardships.userId, input.userId),
        isNull(agentStewardships.endedAt),
      ),
    )
    .then((rows) => rows[0] ?? null);
  return row !== null;
}

/**
 * AgentDash: the steward an issue's current agent assignment was routed from,
 * if that assignment is still the routed one. A routed issue created or
 * assigned in `backlog` gets no assignment wake; the wake that starts it later
 * is a status change, and without this it would not say the work came via the
 * steward. The latest assignment record decides: if it was the routing to
 * this agent, and that person still stewards it, the context carries over.
 *
 * Known limitations, accepted: an update that resends the unchanged assignee
 * writes a newer assignment record without the routing, so a later start from
 * backlog loses the context; and a suggested-task draft accepted and then
 * moved to backlog has no routing record at all (acceptance carries the
 * context only on its own assignment wake). Both start the agent normally,
 * just without the steward line.
 */
export async function routedStewardForCurrentAssignment(
  db: Pick<Db, "select">,
  issue: { id: string; companyId: string; assigneeAgentId: string | null },
): Promise<string | null> {
  if (!issue.assigneeAgentId) return null;
  const latest = await db
    .select({ details: activityLog.details })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, issue.companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, issue.id),
        inArray(activityLog.action, ["issue.created", "issue.child_created", "issue.updated"]),
        sql`(${activityLog.details} ? 'routedToStewardedAgent' or ${activityLog.details} ? 'assigneeAgentId' or ${activityLog.details} ? 'assigneeUserId')`,
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const routed = (latest?.details as Record<string, unknown> | null)?.routedToStewardedAgent as
    | { fromUserId?: unknown; toAgentId?: unknown }
    | undefined;
  if (!routed || routed.toAgentId !== issue.assigneeAgentId || typeof routed.fromUserId !== "string") return null;
  const stillSteward = await isActiveStewardOf(db, {
    companyId: issue.companyId,
    agentId: issue.assigneeAgentId,
    userId: routed.fromUserId,
  });
  return stillSteward ? routed.fromUserId : null;
}

/** Whether an execution policy names this person as a stage participant. */
export function namesStageUser(policy: unknown, userId: string): boolean {
  const stages = (policy as { stages?: unknown } | null | undefined)?.stages;
  if (!Array.isArray(stages)) return false;
  return stages.some((stage) => {
    const participants = (stage as { participants?: unknown } | null)?.participants;
    return Array.isArray(participants) && participants.some((participant) => {
      const p = participant as { type?: unknown; userId?: unknown } | null;
      return p?.type === "user" && p.userId === userId;
    });
  });
}

/**
 * AgentDash: work assigned to a person who stewards an agent goes to that
 * agent, whoever assigns it. Returns the input with `assignToPerson` removed
 * — it is a request flag, never stored — and the assignee moved when the rule
 * applies. On an update, a person who already holds the issue is not a new
 * assignment and is left alone, and an agent handing its issue back to the
 * person who created it (the return-to-creator exemption in
 * issue-patch-actions.ts) is returning work for review, not delegating it, so
 * it is left alone too. Work is never given to an agent the caller cannot see
 * (agent visibility), so a hidden steward's agent leaves the assignment with
 * the person. A person assigning themselves is taking the work, and a person
 * named as a reviewer or approver by the issue's execution policy is that
 * stage's participant: both keep the assignment.
 *
 * One implementation for the issue routes and the batch preview
 * (services/batch/kinds.ts), so a preview never promises a routing the route
 * would not do, and never names an agent the caller cannot see.
 */
export async function routePersonAssignee<
  T extends { assigneeAgentId?: string | null; assigneeUserId?: string | null; assignToPerson?: boolean },
>(
  db: Pick<Db, "select" | "execute">,
  req: Request,
  companyId: string,
  input: T,
  current?: {
    assigneeUserId: string | null;
    assigneeAgentId: string | null;
    createdByUserId: string | null;
    executionPolicy?: unknown;
  },
): Promise<{ input: T; routed: StewardedAgentRoute | null }> {
  const { assignToPerson, ...fields } = input;
  const rest = fields as T;
  if (current && input.assigneeUserId === current.assigneeUserId) return { input: rest, routed: null };
  const actorAgentId = req.actor.type === "agent" ? req.actor.agentId ?? null : null;
  if (
    current &&
    actorAgentId &&
    current.assigneeAgentId === actorAgentId &&
    !!current.createdByUserId &&
    input.assigneeUserId === current.createdByUserId
  ) {
    return { input: rest, routed: null };
  }
  const requestedPolicy = (input as { executionPolicy?: unknown }).executionPolicy;
  if (
    typeof input.assigneeUserId === "string" &&
    namesStageUser(requestedPolicy !== undefined ? requestedPolicy : current?.executionPolicy, input.assigneeUserId)
  ) {
    return { input: rest, routed: null };
  }
  const routed = await resolveStewardedAgentRoute(db, {
    companyId,
    actorAgentId,
    actorUserId: req.actor.type === "board" ? req.actor.userId ?? null : null,
    assigneeAgentId: input.assigneeAgentId,
    assigneeUserId: input.assigneeUserId,
    assignToPerson,
  });
  if (!routed) return { input: rest, routed: null };
  const visibleIds = await visibleAgentIdsFor(db, req, companyId);
  if (visibleIds !== null && !visibleIds.has(routed.toAgentId)) return { input: rest, routed: null };
  return { input: { ...rest, assigneeAgentId: routed.toAgentId, assigneeUserId: null }, routed };
}
