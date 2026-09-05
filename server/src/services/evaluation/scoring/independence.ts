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
 * Contributors (§3): every actor with a write on the item — anyone who changed
 * its status, assignee, blockers or DoD, authored a comment or a self-report
 * payload, ran a heartbeat on it, or was ever its assignee — plus the creator
 * when the creator also acted on it. Review-class acts (verdicts,
 * `tester_to_reviewer` handoffs, approval decisions) are the acts independence
 * judges, so they do not by themselves make their author a contributor;
 * otherwise every second verdict would be a self-review. PR authorship is T1
 * and absent until the GitHub adapter (D4) exists.
 *
 * Independence is judged as of the review: only writes at or before `until`
 * count, so a reviewer who closes the item after recording a verdict has not
 * reviewed their own work.
 */
export function contributors(it: ItemTimeline, until?: Date): Set<string> {
  const out = new Set<string>();
  const within = <T extends { time: Date }>(xs: T[]) => (until ? xs.filter((x) => x.time <= until) : xs);
  const snaps = within(it.snapshots).length > 0 ? within(it.snapshots) : it.snapshots.slice(0, 1);
  for (const s of snaps) {
    if (s.assigneeAgentId) out.add(actorKey("agent", s.assigneeAgentId));
    if (s.assigneeUserId) out.add(actorKey("user", s.assigneeUserId));
  }
  for (const a of within(it.assignments)) {
    if (a.toAgentId) out.add(actorKey("agent", a.toAgentId));
    if (a.toUserId) out.add(actorKey("user", a.toUserId));
    if (a.fromAgentId) out.add(actorKey("agent", a.fromAgentId));
    if (a.fromUserId) out.add(actorKey("user", a.fromUserId));
    if (a.actorType === "agent" && a.actorId) out.add(actorKey("agent", a.actorId));
  }
  for (const list of [it.transitions, it.blockers, it.dods, it.comments] as Array<Array<{ time: Date; actorType: string; actorId: string | null }>>) {
    for (const x of within(list)) if (x.actorType === "agent" && x.actorId) out.add(actorKey("agent", x.actorId));
  }
  for (const r of within(it.runs)) if (r.agentId) out.add(actorKey("agent", r.agentId));
  for (const h of within(it.handoffs)) if (h.type !== "tester_to_reviewer" && h.actorId) out.add(actorKey(h.actorType, h.actorId));
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
  /** The project the item belonged to at `at` (its lead is not independent for the project's own work). */
  projectId?: string | null;
  /** The goal the item closes (its owner is not independent for it). */
  goalId?: string | null;
  /** When the review happened; the item's assignee then is a contributor even if later reassigned. */
  at: Date;
}

/**
 * §4.2, the fuller rule applied to every review-class event: an actor is not
 * independent for an item if it is a contributor, the lead of the project the
 * item belongs to, or the owner of the goal the item closes; a synthetic
 * identity is never independent (rule 15); a founder-declared exclusion never
 * is. Rule 19: a review between actors sharing an `accountableUserId` is
 * allowed and marked.
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
    if (contributors(it, ctx.at).has(key)) return { independent: false, reason: "self_review", sharedAccountability: shared };
    const then = assigneeAt(it, ctx.at);
    if ((then.agentId && actorKey("agent", then.agentId) === key) || (then.userId && actorKey("user", then.userId) === key)) {
      return { independent: false, reason: "self_review", sharedAccountability: shared };
    }
  }
  if (ctx.projectId) {
    const lead = latestLead(tl, ctx.projectId);
    if (lead && actorKey("agent", lead) === key) return { independent: false, reason: "project_lead", sharedAccountability: shared };
  }
  if (ctx.goalId) {
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

/** §9.1 routing: manager := reportsTo; null → the accountable human. Several agents ("both actors' managers") union their managers. */
export function routeFor(agentIds: string | null | Array<string | null>, tl: Timeline, fallbackAccountable: string | null): { managerAgentIds: string[]; accountableUserId: string | null } {
  const ids = (Array.isArray(agentIds) ? agentIds : [agentIds]).filter((x): x is string => !!x);
  const managers = new Set<string>();
  let accountable: string | null = null;
  for (const id of ids) {
    const a = tl.agents.get(id);
    if (!a) continue;
    if (a.reportsTo) managers.add(a.reportsTo);
    accountable = accountable ?? a.accountableUserId ?? null;
  }
  return { managerAgentIds: [...managers].sort(), accountableUserId: accountable ?? fallbackAccountable };
}

/** Independence reasons in founder-readable words (Priya, AGE-97). */
export const INDEPENDENCE_REASON_WORDS: Record<string, string> = {
  self_review: "the contributor reviewed their own work",
  project_lead: "the project lead reviewed their own project's work",
  goal_owner: "the goal owner reviewed work closing their own goal",
  synthetic: "a synthetic identity decided",
  excluded: "a reviewer excluded by the contract",
  no_actor: "no reviewer identity recorded",
};
