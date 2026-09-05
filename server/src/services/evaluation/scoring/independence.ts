import type { EvaluationContractV1 } from "@paperclipai/shared";
import { actorKey, assigneeAt, type ItemTimeline, type Timeline } from "./timeline.js";

/**
 * AgentDash: Company Evaluator — reviewer independence (`independence/v1`,
 * spec §4.2) and synthetic identities (rule 15).
 */

export const INDEPENDENCE_RULE = "independence/v1";

/** Rule 15: identities that can never confer independence (they are not a person). */
const SYNTHETIC_USER_IDS = new Set(["local-board", "board", "system", "instance-admin", "instance_admin"]);

export function isSyntheticUser(userId: string | null | undefined): boolean {
  if (!userId) return true;
  if (SYNTHETIC_USER_IDS.has(userId)) return true;
  return userId.startsWith("local-") || userId.startsWith("synthetic-");
}

/**
 * Contributors (§3): every assignee the item ever had, every agent that ran on
 * it, the authors of its implementation self-reports (`builder_to_ci`), and the
 * creator when the creator also acted on it. PR authorship is T1 and absent
 * until the GitHub adapter (D4) exists.
 */
export function contributors(it: ItemTimeline): Set<string> {
  const out = new Set<string>();
  for (const s of it.snapshots) {
    if (s.assigneeAgentId) out.add(actorKey("agent", s.assigneeAgentId));
    if (s.assigneeUserId) out.add(actorKey("user", s.assigneeUserId));
  }
  for (const a of it.assignments) {
    if (a.toAgentId) out.add(actorKey("agent", a.toAgentId));
    if (a.toUserId) out.add(actorKey("user", a.toUserId));
    if (a.fromAgentId) out.add(actorKey("agent", a.fromAgentId));
    if (a.fromUserId) out.add(actorKey("user", a.fromUserId));
  }
  for (const r of it.runs) if (r.agentId) out.add(actorKey("agent", r.agentId));
  for (const h of it.handoffs) if (h.type === "builder_to_ci" && h.actorId) out.add(actorKey(h.actorType, h.actorId));
  const s0 = it.snapshots[0];
  if (s0) {
    const creator = s0.createdByAgentId ? actorKey("agent", s0.createdByAgentId) : s0.createdByUserId ? actorKey("user", s0.createdByUserId) : null;
    if (creator && (it.runs.some((r) => actorKey("agent", r.agentId) === creator) || it.transitions.some((t) => actorKey(t.actorType, t.actorId) === creator && t.to === "in_progress"))) {
      out.add(creator);
    }
  }
  return out;
}

export type Independence =
  | { independent: true; sharedAccountability: boolean }
  | { independent: false; reason: "self_review" | "synthetic" | "excluded" | "project_lead" | "goal_owner" | "no_actor"; sharedAccountability: boolean };

export interface ReviewContext {
  /** What the review-class event is about. */
  entityType: "issue" | "project" | "goal";
  projectId?: string | null;
  goalId?: string | null;
  /** When the review happened; the item's assignee then is a contributor even if later reassigned. */
  at: Date;
}

/**
 * §4.2: an actor is not independent for an item if it is a contributor, the
 * project lead when the item is the project's own deliverable, or the goal
 * owner when the item closes the goal; a synthetic identity is never
 * independent (rule 15); a founder-declared exclusion never is. Rule 19: a
 * review between actors sharing an `accountableUserId` is allowed and marked.
 */
export function reviewIndependence(
  reviewer: { actorType: string; actorId: string | null },
  it: ItemTimeline | null,
  tl: Timeline,
  contract: EvaluationContractV1 | null,
  ctx: ReviewContext,
): Independence {
  if (!reviewer.actorId) return { independent: false, reason: "no_actor", sharedAccountability: false };
  const key = actorKey(reviewer.actorType, reviewer.actorId);
  const shared = sharedAccountability(reviewer, it, tl);
  if (reviewer.actorType === "user" && isSyntheticUser(reviewer.actorId)) return { independent: false, reason: "synthetic", sharedAccountability: shared };
  if (contract?.excludedReviewers?.includes(reviewer.actorId) || contract?.excludedReviewers?.includes(key)) {
    return { independent: false, reason: "excluded", sharedAccountability: shared };
  }
  if (it) {
    if (contributors(it).has(key)) return { independent: false, reason: "self_review", sharedAccountability: shared };
    const then = assigneeAt(it, ctx.at);
    if ((then.agentId && actorKey("agent", then.agentId) === key) || (then.userId && actorKey("user", then.userId) === key)) {
      return { independent: false, reason: "self_review", sharedAccountability: shared };
    }
  }
  if (ctx.entityType === "project" && ctx.projectId) {
    const lead = latestLead(tl, ctx.projectId);
    if (lead && actorKey("agent", lead) === key) return { independent: false, reason: "project_lead", sharedAccountability: shared };
  }
  if (ctx.entityType === "goal" && ctx.goalId) {
    const list = tl.goals.get(ctx.goalId) ?? [];
    const owner = list[list.length - 1]?.ownerAgentId ?? null;
    if (owner && actorKey("agent", owner) === key) return { independent: false, reason: "goal_owner", sharedAccountability: shared };
  }
  return { independent: true, sharedAccountability: shared };
}

function latestLead(tl: Timeline, projectId: string): string | null {
  const list = tl.projects.get(projectId) ?? [];
  return list[list.length - 1]?.leadAgentId ?? null;
}

/** Rule 19: reviewer and the item's contributors share an accountable human. */
export function sharedAccountability(reviewer: { actorType: string; actorId: string | null }, it: ItemTimeline | null, tl: Timeline): boolean {
  if (!it || reviewer.actorType !== "agent" || !reviewer.actorId) return false;
  const reviewerOwner = tl.agents.get(reviewer.actorId)?.accountableUserId ?? null;
  if (!reviewerOwner) return false;
  for (const key of contributors(it)) {
    if (!key.startsWith("agent:")) continue;
    const owner = tl.agents.get(key.slice("agent:".length))?.accountableUserId ?? null;
    if (owner && owner === reviewerOwner) return true;
  }
  return false;
}

/** §9.1 routing: manager := reportsTo; null → the accountable human. */
export function routeFor(agentId: string | null, tl: Timeline, fallbackAccountable: string | null): { managerAgentIds: string[]; accountableUserId: string | null } {
  if (!agentId) return { managerAgentIds: [], accountableUserId: fallbackAccountable };
  const a = tl.agents.get(agentId);
  if (!a) return { managerAgentIds: [], accountableUserId: fallbackAccountable };
  if (a.reportsTo) return { managerAgentIds: [a.reportsTo], accountableUserId: a.accountableUserId ?? fallbackAccountable };
  return { managerAgentIds: [], accountableUserId: a.accountableUserId ?? fallbackAccountable };
}
