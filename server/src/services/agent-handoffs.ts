import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, costEvents, heartbeatRuns, issues } from "@paperclipai/db";
import { FEATURE_FLAG_KEYS } from "@paperclipai/shared";
import { logActivity } from "./activity-log.js";
import { handoffReturnedCorrectionInput, recordAgentCorrection } from "./agent-corrections.js";
import { featureFlagsService } from "./feature-flags.js";
import { logger } from "../middleware/logger.js";

/**
 * AgentDash: agent-to-agent hand-offs (O5, O7).
 *
 * Agents hand work to each other directly: a child issue assigned to the other
 * agent (or to its person, which routes to the agent). The receiving agent
 * takes the same first pass as for work from a person and decides from its own
 * mandate when to involve its person.
 *
 * What this module adds is a bound. A request — the root issue a hand-off
 * belongs to — may go through at most {@link AGENT_HANDOFF_ROUND_CAP}
 * agent-to-agent rounds. A round is an agent assigning an issue in the request
 * to another agent (create, child create, or reassignment), or a hand-off sent
 * back. The next hand-off is refused and the agent is told to ask its person.
 * Sending work back is counted but never refused: refusing it would strand the
 * work with an agent that already said it cannot do it.
 *
 * Every round is an activity row on the handed-off issue, carrying the root
 * request. That row is both the audit record and the counter, so there is no
 * new table and no new budget system. Known limitation: two hand-offs racing at
 * the last round can both pass, because the count and the issue write are not
 * one transaction; the cap is a guard against runaway delegation, not a quota.
 * The count filters activity rows on a JSON field with no index of its own, so
 * routes take it before an update's transaction opens rather than inside it.
 *
 * Like the rest of the co-worker feature, this is server behavior behind the
 * company flag `coworker_bridge_enabled` (default off): with the flag off,
 * hand-offs are neither recorded nor capped, exactly as before. The mandate
 * text describing hand-offs is not flagged.
 *
 * The root of an issue is the top of its parent chain. An issue created without
 * a parent by an agent running on a request belongs to that request (the run's
 * issue), and its hand-off row records that root, so the issues under it
 * resolve to the same request.
 *
 * Because the count follows the parent chain, an agent must not be able to
 * choose a fresh chain. So, with the flag on, an agent may place a hand-off
 * (create one with a parent) or move an issue (change its parent) only under
 * an issue it holds -- is the assignee of -- or under work below one
 * ({@link isUnderIssueHeldBy}); anything else is refused with
 * {@link AGENT_HANDOFF_PARENT_CODE}. Its own work is the only place it can put
 * a hand-off, so a hand-off always counts against a request the agent is
 * already working on. Likewise an unparented issue an agent created for itself
 * and later reassigns belongs to its run's request, exactly as if it had been
 * created as the hand-off ({@link resolveRequestRootForReassign}).
 */

export const AGENT_HANDOFF_ROUND_CAP = 3;
export const AGENT_HANDOFF_ACTION = "issue.agent_handoff";
export const AGENT_HANDOFF_RETURNED_ACTION = "issue.agent_handoff_returned";
export const AGENT_HANDOFF_REFUSED_ACTION = "issue.agent_handoff_refused";
export const AGENT_HANDOFF_CAP_CODE = "AGENT_HANDOFF_CAP_REACHED";
export const AGENT_HANDOFF_PARENT_CODE = "AGENT_HANDOFF_PARENT_NOT_HELD";

/** Parent chains deeper than this are treated as rooted where the walk stopped. */
const MAX_PARENT_DEPTH = 64;
/** Rows returned by the per-request summary. */
const MAX_SUMMARY_HANDOFFS = 50;

const ROUND_ACTIONS = [AGENT_HANDOFF_ACTION, AGENT_HANDOFF_RETURNED_ACTION];

type Reader = Pick<Db, "select">;

export type AgentHandoffVia = "create" | "child_create" | "reassign";
export type AgentHandoffReturnKind = "reassigned" | "declined";

/** Is hand-off accounting (recording and the cap) on for this company? */
export async function agentHandoffsEnabled(db: Reader, companyId: string): Promise<boolean> {
  return featureFlagsService(db as Db).isEnabled(companyId, FEATURE_FLAG_KEYS.COWORKER_BRIDGE);
}

export function agentHandoffParentMessage(kind: "handoff" | "move"): string {
  const what = kind === "handoff" ? "hand work to another agent" : "move an issue";
  return (
    `You can ${what} only under an issue you hold (are assigned to), or under work below one. ` +
    "Put it under the issue you are working on, or leave the parent out to hand it off as part of the " +
    "request your current run is on."
  );
}

/**
 * Is this issue held by the agent (it is the assignee), or below an issue the
 * agent holds? Walks the parent chain from the issue itself.
 */
export async function isUnderIssueHeldBy(
  db: Reader,
  input: { companyId: string; issueId: string; agentId: string },
): Promise<boolean> {
  let current: string | null = input.issueId;
  const seen = new Set<string>();
  for (let depth = 0; current && depth <= MAX_PARENT_DEPTH && !seen.has(current); depth += 1) {
    seen.add(current);
    const row: { parentId: string | null; assigneeAgentId: string | null } | null = await db
      .select({ parentId: issues.parentId, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(and(eq(issues.id, current), eq(issues.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!row) return false;
    if (row.assigneeAgentId === input.agentId) return true;
    current = row.parentId;
  }
  return false;
}

export function agentHandoffCapMessage(rounds: number): string {
  return (
    `This request has already been handed between agents ${rounds} times, which is the limit ` +
    `(${AGENT_HANDOFF_ROUND_CAP} hand-off rounds per request). Do not hand it to another agent again. ` +
    "Ask your person how to proceed: ask_user_questions on the issue you are working on, " +
    "with what you need and from whom, then set it to blocked."
  );
}

/** The hand-off record for one issue, if an agent handed it to another agent. */
export async function latestHandoffForIssue(
  db: Reader,
  input: { companyId: string; issueId: string },
): Promise<{ rootIssueId: string; fromAgentId: string | null; toAgentId: string | null } | null> {
  const row = await db
    .select({ details: activityLog.details })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, input.issueId),
        eq(activityLog.action, AGENT_HANDOFF_ACTION),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const details = row?.details as Record<string, unknown> | null | undefined;
  if (!details || typeof details.rootIssueId !== "string") return null;
  return {
    rootIssueId: details.rootIssueId,
    fromAgentId: typeof details.fromAgentId === "string" ? details.fromAgentId : null,
    toAgentId: typeof details.toAgentId === "string" ? details.toAgentId : null,
  };
}

/**
 * The request an issue belongs to: the top of its parent chain, or, when that
 * top was itself handed off without a parent from a run on another request,
 * that request.
 */
export async function resolveRequestRootIssueId(
  db: Reader,
  input: { companyId: string; issueId: string },
): Promise<string> {
  let current = input.issueId;
  const seen = new Set<string>([current]);
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
    const row = await db
      .select({ parentId: issues.parentId })
      .from(issues)
      .where(and(eq(issues.id, current), eq(issues.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!row?.parentId || seen.has(row.parentId)) break;
    seen.add(row.parentId);
    current = row.parentId;
  }
  const handoff = await latestHandoffForIssue(db, { companyId: input.companyId, issueId: current });
  return handoff?.rootIssueId ?? current;
}

/**
 * The request an agent's new, unparented issue belongs to: the issue its run
 * is working on, if the run says so and that issue is in the same company.
 */
export async function requestRootForAgentRun(
  db: Reader,
  input: { companyId: string; agentId: string; runId: string | null | undefined },
): Promise<string | null> {
  if (!input.runId) return null;
  const run = await db
    .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
      ),
    )
    .then((rows) => rows[0] ?? null);
  const issueId = run?.contextSnapshot?.issueId;
  if (typeof issueId !== "string" || !issueId) return null;
  const exists = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, input.companyId)))
    .then((rows) => rows[0] ?? null);
  if (!exists) return null;
  return resolveRequestRootIssueId(db, { companyId: input.companyId, issueId });
}

/**
 * The request an agent's reassignment counts against: the issue's own root,
 * except that an unparented issue the agent created for itself, with no
 * hand-off record, belongs to the request its run is on -- the same request
 * it would have belonged to had it been created as the hand-off. Without this,
 * creating work for yourself and then reassigning it would start a fresh count.
 */
export async function resolveRequestRootForReassign(
  db: Reader,
  input: {
    companyId: string;
    issue: { id: string; parentId: string | null; createdByAgentId: string | null };
    agentId: string;
    runId: string | null | undefined;
  },
): Promise<string> {
  const root = await resolveRequestRootIssueId(db, { companyId: input.companyId, issueId: input.issue.id });
  if (root !== input.issue.id || input.issue.parentId || input.issue.createdByAgentId !== input.agentId) return root;
  return (await requestRootForAgentRun(db, { companyId: input.companyId, agentId: input.agentId, runId: input.runId })) ?? root;
}

/** Rounds used so far by a request: hand-offs plus hand-offs sent back. */
export async function countHandoffRounds(
  db: Reader,
  input: { companyId: string; rootIssueId: string },
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, input.companyId),
        inArray(activityLog.action, ROUND_ACTIONS),
        sql`${activityLog.details} ->> 'rootIssueId' = ${input.rootIssueId}`,
      ),
    );
  return Number(row?.count ?? 0);
}

export type HandoffRoundCheck =
  | { allowed: true; rounds: number }
  | { allowed: false; rounds: number; message: string; details: Record<string, unknown> };

/**
 * The cap decision for a request that has used `rounds` rounds. The refusal
 * names the request's root only when `revealRoot` says the acting agent can
 * see it; a root in a restricted project it is not on stays unnamed.
 */
export function handoffRoundCheck(rounds: number, rootIssueId: string, opts: { revealRoot?: boolean } = {}): HandoffRoundCheck {
  if (rounds < AGENT_HANDOFF_ROUND_CAP) return { allowed: true, rounds };
  return {
    allowed: false,
    rounds,
    message: agentHandoffCapMessage(rounds),
    details: {
      code: AGENT_HANDOFF_CAP_CODE,
      rounds,
      cap: AGENT_HANDOFF_ROUND_CAP,
      ...(opts.revealRoot === false ? {} : { rootIssueId }),
    },
  };
}

/** May an agent hand an issue in this request to another agent now? */
export async function checkHandoffRoundAvailable(
  db: Reader,
  input: { companyId: string; rootIssueId: string; revealRoot?: boolean },
): Promise<HandoffRoundCheck> {
  return handoffRoundCheck(await countHandoffRounds(db, input), input.rootIssueId, { revealRoot: input.revealRoot });
}

/** Record one agent-to-agent hand-off. Returns the round it used. */
export async function recordAgentHandoff(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    parentIssueId: string | null;
    rootIssueId: string;
    fromAgentId: string;
    toAgentId: string;
    runId: string | null;
    via: AgentHandoffVia;
    routedFromUserId?: string | null;
  },
): Promise<number> {
  const round = (await countHandoffRounds(db, input)) + 1;
  await logActivity(db, {
    companyId: input.companyId,
    actorType: "agent",
    actorId: input.fromAgentId,
    agentId: input.fromAgentId,
    runId: input.runId,
    action: AGENT_HANDOFF_ACTION,
    entityType: "issue",
    entityId: input.issueId,
    details: {
      rootIssueId: input.rootIssueId,
      parentIssueId: input.parentIssueId,
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      via: input.via,
      round,
      cap: AGENT_HANDOFF_ROUND_CAP,
      ...(input.routedFromUserId ? { routedFromUserId: input.routedFromUserId } : {}),
    },
  });
  return round;
}

/** Record a refused hand-off on the issue the agent was working from. */
export async function recordAgentHandoffRefused(
  db: Db,
  input: {
    companyId: string;
    entityIssueId: string;
    rootIssueId: string;
    fromAgentId: string;
    toAgentId: string;
    runId: string | null;
    rounds: number;
  },
): Promise<void> {
  await logActivity(db, {
    companyId: input.companyId,
    actorType: "agent",
    actorId: input.fromAgentId,
    agentId: input.fromAgentId,
    runId: input.runId,
    action: AGENT_HANDOFF_REFUSED_ACTION,
    entityType: "issue",
    entityId: input.entityIssueId,
    details: {
      code: AGENT_HANDOFF_CAP_CODE,
      rootIssueId: input.rootIssueId,
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      rounds: input.rounds,
      cap: AGENT_HANDOFF_ROUND_CAP,
    },
  });
}

/**
 * A hand-off came back: the receiving agent reassigned the issue to the agent
 * that handed it over (or the parent's agent), or cancelled it, with a reason.
 *
 * This is the returned-hand-off correction signal. It records the return and
 * its reason on the issue activity, counted as a round of the request, and
 * queues the "what changed" summary for the receiving agent's next wake
 * (services/agent-corrections.ts).
 */
export async function emitHandoffReturned(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    parentIssueId: string | null;
    rootIssueId: string;
    /** The agent sending the work back. */
    fromAgentId: string;
    /** The agent receiving it back, when there is one. */
    toAgentId: string | null;
    kind: AgentHandoffReturnKind;
    /** Why, in the returning agent's words (its comment); null when it gave none. */
    reason: string | null;
    runId: string | null;
  },
): Promise<number> {
  const round = (await countHandoffRounds(db, input)) + 1;
  await logActivity(db, {
    companyId: input.companyId,
    actorType: "agent",
    actorId: input.fromAgentId,
    agentId: input.fromAgentId,
    runId: input.runId,
    action: AGENT_HANDOFF_RETURNED_ACTION,
    entityType: "issue",
    entityId: input.issueId,
    details: {
      rootIssueId: input.rootIssueId,
      parentIssueId: input.parentIssueId,
      fromAgentId: input.fromAgentId,
      toAgentId: input.toAgentId,
      kind: input.kind,
      reason: input.reason,
      round,
      cap: AGENT_HANDOFF_ROUND_CAP,
    },
  });
  // The returned-hand-off correction signal: the agent that handed the work
  // over is told, on its next wake, that it came back and why. Logged and
  // never thrown -- the return itself is already recorded.
  try {
    const correction = await handoffReturnedCorrectionInput(db, input);
    if (correction) await recordAgentCorrection(db, correction);
  } catch (err) {
    logger.warn({ err, issueId: input.issueId }, "hand-off return correction not recorded");
  }
  return round;
}

/**
 * Every issue in a request: the root, everything under it, and everything
 * under an unparented issue handed off from a run on it.
 */
export async function listRequestIssueIds(
  db: Reader,
  input: { companyId: string; rootIssueId: string },
): Promise<string[]> {
  const linked = await db
    .select({ entityId: activityLog.entityId })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.action, AGENT_HANDOFF_ACTION),
        sql`${activityLog.details} ->> 'rootIssueId' = ${input.rootIssueId}`,
      ),
    );
  const seeds = new Set<string>([input.rootIssueId, ...linked.map((row) => row.entityId)]);
  const ids = new Set<string>();
  let frontier = [...seeds];
  for (let depth = 0; depth <= MAX_PARENT_DEPTH && frontier.length > 0; depth += 1) {
    const present = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, input.companyId), inArray(issues.id, frontier)));
    for (const row of present) ids.add(row.id);
    const children = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, input.companyId), inArray(issues.parentId, frontier)));
    frontier = children.map((row) => row.id).filter((id) => !ids.has(id));
  }
  return [...ids];
}

export interface RequestHandoffEntry {
  issueId: string;
  identifier: string | null;
  kind: "handoff" | AgentHandoffReturnKind;
  fromAgentId: string | null;
  toAgentId: string | null;
  round: number | null;
  at: string;
}

/**
 * The per-request tally an agent (or a person) reads: rounds used, the cap,
 * the deliverable owner (the agent the request itself is assigned to, O7), the
 * hand-offs it can see, and — only for readers allowed to see spend — the cost
 * recorded against the request's issues it can see.
 *
 * Visibility: the deliverable owner is reported only to a reader who can see
 * the root issue, and the hand-off list and cost cover visible issues only.
 * `rounds` and `remaining` deliberately count every issue in the request,
 * restricted ones included: that is what the cap counts, and a refused
 * hand-off already reports the same count (`details.rounds`) to the agent.
 * A per-reader count would tell an agent it has rounds left that the server
 * then refuses.
 */
export async function summarizeRequestHandoffs(
  db: Reader,
  input: {
    companyId: string;
    rootIssueId: string;
    /** Issues in the request the reader can see. */
    visibleIssueIds: Set<string>;
    canReadSpend: boolean;
  },
): Promise<{
  rounds: number;
  cap: number;
  remaining: number;
  deliverableOwnerAgentId: string | null;
  handoffs: RequestHandoffEntry[];
  costCents: number | null;
}> {
  const rounds = await countHandoffRounds(db, input);
  const root = input.visibleIssueIds.has(input.rootIssueId)
    ? await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(and(eq(issues.id, input.rootIssueId), eq(issues.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null)
    : null;
  const events = await db
    .select({ action: activityLog.action, entityId: activityLog.entityId, details: activityLog.details, createdAt: activityLog.createdAt })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, input.companyId),
        inArray(activityLog.action, ROUND_ACTIONS),
        sql`${activityLog.details} ->> 'rootIssueId' = ${input.rootIssueId}`,
      ),
    )
    .orderBy(activityLog.createdAt)
    .limit(MAX_SUMMARY_HANDOFFS);
  const visibleEvents = events.filter((event) => input.visibleIssueIds.has(event.entityId));
  const identifiers = visibleEvents.length
    ? await db
      .select({ id: issues.id, identifier: issues.identifier })
      .from(issues)
      .where(and(eq(issues.companyId, input.companyId), inArray(issues.id, visibleEvents.map((event) => event.entityId))))
    : [];
  const identifierById = new Map(identifiers.map((row) => [row.id, row.identifier]));
  const handoffs = visibleEvents.map((event): RequestHandoffEntry => {
    const details = (event.details ?? {}) as Record<string, unknown>;
    const returnKind = details.kind === "declined" ? "declined" : "reassigned";
    return {
      issueId: event.entityId,
      identifier: identifierById.get(event.entityId) ?? null,
      kind: event.action === AGENT_HANDOFF_ACTION ? "handoff" : returnKind,
      fromAgentId: typeof details.fromAgentId === "string" ? details.fromAgentId : null,
      toAgentId: typeof details.toAgentId === "string" ? details.toAgentId : null,
      round: typeof details.round === "number" ? details.round : null,
      at: event.createdAt.toISOString(),
    };
  });

  let costCents: number | null = null;
  if (input.canReadSpend) {
    const ids = [...input.visibleIssueIds];
    if (ids.length === 0) {
      costCents = 0;
    } else {
      const [row] = await db
        .select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
        .from(costEvents)
        .where(and(eq(costEvents.companyId, input.companyId), inArray(costEvents.issueId, ids)));
      costCents = Number(row?.total ?? 0);
    }
  }

  return {
    rounds,
    cap: AGENT_HANDOFF_ROUND_CAP,
    remaining: Math.max(0, AGENT_HANDOFF_ROUND_CAP - rounds),
    deliverableOwnerAgentId: root?.assigneeAgentId ?? null,
    handoffs,
    costCents,
  };
}
