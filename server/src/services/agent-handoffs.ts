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
 * The request of an issue -- its primary root -- is the top of its parent
 * chain, or, when that top carries a root record (below), the request that
 * record names. That primary root is what the per-request summary reports.
 *
 * Counting follows every request an issue belongs to, not only the primary
 * one, because an agent chooses where it puts work and must not be able to
 * restart the count by choosing:
 *
 * - An issue an agent creates during a run on an issue -- for itself or for
 *   anyone, with or without a parent -- carries a root record
 *   ({@link AGENT_REQUEST_ROOTS_ACTION}) naming the run's requests, and a
 *   hand-off row names them too. So work the agent made for itself, under a
 *   request or on its own, still belongs to the request it was working on.
 * - An agent moving an issue to another parent (or to none) leaves a root
 *   record naming the requests it was in, so the move does not take it out.
 * - A hand-off counts against the requests of the issue it is placed under (or
 *   reassigned from) AND the requests of the run the agent is on, and is
 *   refused when any of them is at the cap ({@link resolveRequestRoots},
 *   {@link requestRootsForAgentRun}, {@link checkHandoffRounds}).
 *
 * The run is chosen by the server ({@link countedAgentRunIds}): a run token's
 * own run, or for an agent key a header run only while it is running, else
 * every run of the agent running now. When none of them is on an issue (a
 * timer wake, or no run at all), an unparented hand-off or a new issue is a
 * request of its own, and the hand-off is still counted as its first round.
 * Rows written by hand (origin "manual") or as a person are never counted.
 */

export const AGENT_HANDOFF_ROUND_CAP = 3;
export const AGENT_HANDOFF_ACTION = "issue.agent_handoff";
export const AGENT_HANDOFF_RETURNED_ACTION = "issue.agent_handoff_returned";
export const AGENT_HANDOFF_REFUSED_ACTION = "issue.agent_handoff_refused";
export const AGENT_HANDOFF_CAP_CODE = "AGENT_HANDOFF_CAP_REACHED";
/**
 * A root record: the requests an issue belongs to beyond its parent chain,
 * written when an agent creates an issue during a run on another, or moves an
 * issue. Not a round.
 */
export const AGENT_REQUEST_ROOTS_ACTION = "issue.agent_request_roots";

/** Parent chains deeper than this are treated as rooted where the walk stopped. */
const MAX_PARENT_DEPTH = 64;
/** Rows returned by the per-request summary. */
const MAX_SUMMARY_HANDOFFS = 50;

const ROUND_ACTIONS = [AGENT_HANDOFF_ACTION, AGENT_HANDOFF_RETURNED_ACTION];
/** Rows that say which requests an issue belongs to. */
const ROOT_RECORD_ACTIONS = [AGENT_HANDOFF_ACTION, AGENT_REQUEST_ROOTS_ACTION];

type Reader = Pick<Db, "select">;

export type AgentHandoffVia = "create" | "child_create" | "reassign";
export type AgentHandoffReturnKind = "reassigned" | "declined";

/** Is hand-off accounting (recording and the cap) on for this company? */
export async function agentHandoffsEnabled(db: Reader, companyId: string): Promise<boolean> {
  return featureFlagsService(db as Db).isEnabled(companyId, FEATURE_FLAG_KEYS.COWORKER_BRIDGE);
}

export function agentHandoffCapMessage(rounds: number): string {
  return (
    `This request has already been handed between agents ${rounds} times, which is the limit ` +
    `(${AGENT_HANDOFF_ROUND_CAP} hand-off rounds per request). Do not hand it to another agent again. ` +
    "Ask your person how to proceed: ask_user_questions on the issue you are working on, " +
    "with what you need and from whom, then set it to blocked."
  );
}

/** Every root a row names: `rootIssueId` and, on newer rows, `rootIssueIds`. */
function rootsOfDetails(details: unknown): string[] {
  const d = (details ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  if (typeof d.rootIssueId === "string") out.push(d.rootIssueId);
  if (Array.isArray(d.rootIssueIds)) for (const id of d.rootIssueIds) if (typeof id === "string") out.push(id);
  return out;
}

const unique = (ids: Array<string | null | undefined>) => [...new Set(ids.filter((id): id is string => Boolean(id)))];

/**
 * Rows the count may trust: written by the server for an agent or the system.
 * A row a board user posted by hand (origin "manual"), or one written as a
 * person, neither adds a request nor spends a round.
 */
const trustedRootRow = () =>
  sql`(coalesce(${activityLog.origin}, 'server') <> 'manual' and ${activityLog.actorType} in ('agent', 'system'))`;

/** Does this activity row name `rootIssueId` among its requests? */
function rowNamesRoot(rootIssueId: string) {
  return sql`(${activityLog.details} ->> 'rootIssueId' = ${rootIssueId}
    or coalesce(${activityLog.details} -> 'rootIssueIds', '[]'::jsonb) @> jsonb_build_array(${rootIssueId}::text))`;
}

/** The hand-off record for one issue, if an agent handed it to another agent. */
export async function latestHandoffForIssue(
  db: Reader,
  input: { companyId: string; issueId: string },
): Promise<{ rootIssueId: string; rootIssueIds: string[]; fromAgentId: string | null; toAgentId: string | null } | null> {
  const row = await db
    .select({ details: activityLog.details })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, input.issueId),
        eq(activityLog.action, AGENT_HANDOFF_ACTION),
        trustedRootRow(),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const details = row?.details as Record<string, unknown> | null | undefined;
  if (!details || typeof details.rootIssueId !== "string") return null;
  return {
    rootIssueId: details.rootIssueId,
    rootIssueIds: unique(rootsOfDetails(details)),
    fromAgentId: typeof details.fromAgentId === "string" ? details.fromAgentId : null,
    toAgentId: typeof details.toAgentId === "string" ? details.toAgentId : null,
  };
}

/** The issue and its ancestors, nearest first, ending at the top. */
async function parentChain(db: Reader, companyId: string, issueId: string): Promise<string[]> {
  const chain = [issueId];
  let current = issueId;
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
    const row = await db
      .select({ parentId: issues.parentId })
      .from(issues)
      .where(and(eq(issues.id, current), eq(issues.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!row?.parentId || chain.includes(row.parentId)) break;
    chain.push(row.parentId);
    current = row.parentId;
  }
  return chain;
}

/**
 * Every request an issue belongs to: the top of its parent chain, the request
 * a root record on that top names (the primary root), and every request named
 * by a hand-off row or root record anywhere on the chain.
 */
export async function resolveRequestRoots(
  db: Reader,
  input: { companyId: string; issueId: string },
): Promise<{ primary: string; roots: string[] }> {
  const chain = await parentChain(db, input.companyId, input.issueId);
  const top = chain[chain.length - 1]!;
  const rows = await db
    .select({ entityId: activityLog.entityId, details: activityLog.details, createdAt: activityLog.createdAt })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.entityType, "issue"),
        inArray(activityLog.entityId, chain),
        inArray(activityLog.action, ROOT_RECORD_ACTIONS),
        trustedRootRow(),
      ),
    )
    .orderBy(desc(activityLog.createdAt));
  const topRecord = rows.find((row) => row.entityId === top && typeof (row.details as Record<string, unknown> | null)?.rootIssueId === "string");
  const primary = topRecord ? String((topRecord.details as Record<string, unknown>).rootIssueId) : top;
  return { primary, roots: unique([primary, top, ...rows.flatMap((row) => rootsOfDetails(row.details))]) };
}

/** The request an issue belongs to (its primary root). */
export async function resolveRequestRootIssueId(
  db: Reader,
  input: { companyId: string; issueId: string },
): Promise<string> {
  return (await resolveRequestRoots(db, input)).primary;
}

/**
 * The runs an agent's call is counted against, chosen by the server, never by
 * the caller alone:
 *
 * - a run token (`agent_jwt`): the run it was signed for, whatever header was
 *   sent (the frame-run rule, services/frame-run.ts);
 * - an agent key: the run the header names only when it is this agent's and
 *   running now; otherwise -- no header, an ended run, someone else's run --
 *   every run of this agent that is running now.
 *
 * Empty when the agent is in no run at all.
 */
export async function countedAgentRunIds(
  db: Reader,
  input: { companyId: string; agentId: string; runId?: string | null; jwtRunId?: string | null },
): Promise<string[]> {
  if (input.jwtRunId) return [input.jwtRunId];
  const running = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        eq(heartbeatRuns.status, "running"),
      ),
    );
  const ids = running.map((row) => row.id);
  if (input.runId && ids.includes(input.runId)) return [input.runId];
  return ids;
}

/**
 * The requests an agent's call is working on: those of the issues its counted
 * runs ({@link countedAgentRunIds}) are on. Null when none of them is on an
 * issue (no run, or a timer wake), in which case a new unparented issue is a
 * request of its own.
 */
export async function requestRootsForAgentRun(
  db: Reader,
  input: { companyId: string; agentId: string; runId?: string | null; jwtRunId?: string | null },
): Promise<{ primary: string; roots: string[] } | null> {
  const runIds = await countedAgentRunIds(db, input);
  if (runIds.length === 0) return null;
  const runs = await db
    .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns)
    .where(
      and(
        inArray(heartbeatRuns.id, runIds),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
      ),
    );
  const issueIds = unique(
    runs.map((run) => {
      const issueId = run.contextSnapshot?.issueId;
      return typeof issueId === "string" ? issueId : null;
    }),
  );
  if (issueIds.length === 0) return null;
  const present = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(inArray(issues.id, issueIds), eq(issues.companyId, input.companyId)));
  let result: { primary: string; roots: string[] } | null = null;
  for (const issueId of issueIds.filter((id) => present.some((row) => row.id === id))) {
    const resolved = await resolveRequestRoots(db, { companyId: input.companyId, issueId });
    result = result ? { primary: result.primary, roots: unique([...result.roots, ...resolved.roots]) } : resolved;
  }
  return result;
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
        rowNamesRoot(input.rootIssueId),
        trustedRootRow(),
      ),
    );
  return Number(row?.count ?? 0);
}

/**
 * The most rounds any of these requests has used, and which request that is
 * (the first listed on a tie, so the primary root is named when it is full).
 */
export async function checkHandoffRounds(
  db: Reader,
  input: { companyId: string; roots: string[] },
): Promise<{ rounds: number; rootIssueId: string | null }> {
  let best: { rounds: number; rootIssueId: string | null } = { rounds: 0, rootIssueId: input.roots[0] ?? null };
  for (const rootIssueId of unique(input.roots)) {
    const rounds = await countHandoffRounds(db, { companyId: input.companyId, rootIssueId });
    if (rounds > best.rounds) best = { rounds, rootIssueId };
  }
  return best;
}

/** The requests of an issue placed under `parentId` (or none) by an agent's run, together. */
export async function requestRootsForPlacement(
  db: Reader,
  input: { companyId: string; agentId: string; runId?: string | null; jwtRunId?: string | null; parentId: string | null },
): Promise<{ primary: string | null; roots: string[] }> {
  const parent = input.parentId ? await resolveRequestRoots(db, { companyId: input.companyId, issueId: input.parentId }) : null;
  const run = await requestRootsForAgentRun(db, input);
  return { primary: parent?.primary ?? run?.primary ?? null, roots: unique([...(parent?.roots ?? []), ...(run?.roots ?? [])]) };
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

/** Record which requests an issue belongs to (an agent's create, or an agent's move). */
export async function recordAgentRequestRoots(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    agentId: string;
    runId: string | null;
    rootIssueId: string;
    rootIssueIds: string[];
    reason: "created" | "moved";
  },
): Promise<void> {
  await logActivity(db, {
    companyId: input.companyId,
    actorType: "agent",
    actorId: input.agentId,
    agentId: input.agentId,
    runId: input.runId,
    action: AGENT_REQUEST_ROOTS_ACTION,
    entityType: "issue",
    entityId: input.issueId,
    details: { rootIssueId: input.rootIssueId, rootIssueIds: unique([input.rootIssueId, ...input.rootIssueIds]), reason: input.reason },
  });
}

/** Record one agent-to-agent hand-off. Returns the round it used. */
export async function recordAgentHandoff(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    parentIssueId: string | null;
    /** The primary root: the request the summary reports this hand-off under. */
    rootIssueId: string;
    /** Every request it counts against (the placement's and the run's). */
    rootIssueIds?: string[];
    fromAgentId: string;
    toAgentId: string;
    runId: string | null;
    via: AgentHandoffVia;
    routedFromUserId?: string | null;
  },
): Promise<number> {
  const rootIssueIds = unique([input.rootIssueId, ...(input.rootIssueIds ?? [])]);
  const round = (await checkHandoffRounds(db, { companyId: input.companyId, roots: rootIssueIds })).rounds + 1;
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
      rootIssueIds,
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
    /** Every request the return counts against; defaults to the primary root. */
    rootIssueIds?: string[];
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
  const rootIssueIds = unique([input.rootIssueId, ...(input.rootIssueIds ?? [])]);
  const round = (await checkHandoffRounds(db, { companyId: input.companyId, roots: rootIssueIds })).rounds + 1;
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
      rootIssueIds,
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
 * under an issue whose hand-off row or root record names the request.
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
        inArray(activityLog.action, ROOT_RECORD_ACTIONS),
        rowNamesRoot(input.rootIssueId),
        trustedRootRow(),
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
        rowNamesRoot(input.rootIssueId),
        trustedRootRow(),
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
