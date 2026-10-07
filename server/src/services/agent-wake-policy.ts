import { and, eq, sql, type SQL } from "drizzle-orm";
import { agents, environments, issues, type Db } from "@paperclipai/db";
import type { AgentWakePolicy, AgentWakePolicyRefusalCode } from "@paperclipai/shared";

/**
 * AgentDash (wake policy): the per-agent rule for which wakes may start a run.
 *
 * `runtimeConfig.wakePolicy = "board_assignment_only"` means "only a board
 * member assigning an issue — with a board API key — may start a run". It is a
 * generic per-agent setting: one behaviour for every company, no per-company
 * branching. Every agent without it keeps the default behaviour unchanged.
 *
 * Legacy alias: `metadata.travelPairing === true` (set by the Track C pairing
 * provisioner before this policy existed) enables the same policy, so agents
 * provisioned that way keep working without being reprovisioned.
 *
 * Refusals keep the original travel-pairing reason codes verbatim; external
 * harnesses match on them. See doc/AGENT-WAKE-POLICY.md.
 */

export const BOARD_ASSIGNMENT_ONLY_WAKE_POLICY = "board_assignment_only" as const satisfies AgentWakePolicy;

export const WAKE_POLICY_REFUSAL = {
  wakeSource: "travel_pairing.wake_source",
  notIssueAssignment: "travel_pairing.not_issue_assignment",
  notBoardKey: "travel_pairing.not_board_key",
  noEnvironment: "travel_pairing.no_environment",
  environmentMismatch: "travel_pairing.environment_mismatch",
} as const satisfies Record<string, AgentWakePolicyRefusalCode>;

/**
 * Reserved wakeup-request payload key carrying the requesting credential kind
 * ("board_key", "session", "agent_key", ...). Written by the server from the
 * authenticated request, never trusted from a caller: any value a caller
 * smuggles in under this key is overwritten (or removed) by enqueueWakeup.
 * The deferred-wake promotion lane re-reads it to re-check the policy.
 */
export const WAKE_PAYLOAD_REQUESTED_BY_CREDENTIAL_KEY = "requestedVia";

type AgentPolicyFields = {
  runtimeConfig?: unknown;
  metadata?: unknown;
} | null | undefined;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The agent's effective wake policy (the legacy alias resolves to board_assignment_only). */
export function resolveAgentWakePolicy(agent: AgentPolicyFields): AgentWakePolicy {
  if (asRecord(agent?.runtimeConfig)?.wakePolicy === BOARD_ASSIGNMENT_ONLY_WAKE_POLICY) {
    return BOARD_ASSIGNMENT_ONLY_WAKE_POLICY;
  }
  if (asRecord(agent?.metadata)?.travelPairing === true) {
    return BOARD_ASSIGNMENT_ONLY_WAKE_POLICY;
  }
  return "default";
}

export function isBoardAssignmentOnlyAgent(agent: AgentPolicyFields): boolean {
  return resolveAgentWakePolicy(agent) === BOARD_ASSIGNMENT_ONLY_WAKE_POLICY;
}

/**
 * SQL predicate over `agents` — true for agents that are NOT under the
 * board_assignment_only policy. For sweeps (run healer, stranded-issue
 * recovery) that must not touch policy agents at all.
 */
export function agentNotBoardAssignmentOnlySql(): SQL {
  return sql`(coalesce(${agents.runtimeConfig} ->> 'wakePolicy', '') <> ${BOARD_ASSIGNMENT_ONLY_WAKE_POLICY}
    and coalesce(${agents.metadata} ->> 'travelPairing', '') <> 'true')`;
}

/**
 * The front-door rule, first match wins (a → c). The environment rule (d) is
 * separate because it needs a database read; see
 * `boardAssignmentOnlyEnvironmentRefusal`.
 *   a. the wake source is not "assignment"            → travel_pairing.wake_source
 *   b. the wake reason is not "issue_assigned"         → travel_pairing.not_issue_assignment
 *   c. the requester did not use a board API key       → travel_pairing.not_board_key
 */
export function boardAssignmentOnlyWakeRefusal(input: {
  source: string | null | undefined;
  reason: string | null | undefined;
  requestedByActorType: string | null | undefined;
  requestedByCredential: string | null | undefined;
}): AgentWakePolicyRefusalCode | null {
  if (input.source !== "assignment") return WAKE_POLICY_REFUSAL.wakeSource;
  if (input.reason !== "issue_assigned") return WAKE_POLICY_REFUSAL.notIssueAssignment;
  if (input.requestedByActorType !== "user" || input.requestedByCredential !== "board_key") {
    return WAKE_POLICY_REFUSAL.notBoardKey;
  }
  return null;
}

/**
 * Rule b, second half: an `issue_assigned` wake must name an issue of the
 * agent's company that is actually assigned to this agent right now. Without
 * it, a board-key caller could forge an "assignment" through the generic
 * wakeup endpoint with no issue behind it.
 */
export async function boardAssignmentOnlyIssueRefusal(
  dbOrTx: Pick<Db, "select">,
  agent: { id: string; companyId: string },
  issueId: string | null | undefined,
): Promise<AgentWakePolicyRefusalCode | null> {
  const id = issueId?.trim() || null;
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return WAKE_POLICY_REFUSAL.notIssueAssignment;
  }
  const issue = await dbOrTx
    .select({ assigneeAgentId: issues.assigneeAgentId })
    .from(issues)
    .where(and(eq(issues.id, id), eq(issues.companyId, agent.companyId)))
    .then((rows) => rows[0] ?? null);
  if (!issue || issue.assigneeAgentId !== agent.id) return WAKE_POLICY_REFUSAL.notIssueAssignment;
  return null;
}

/**
 * Rule d: the agent must be pinned (`defaultEnvironmentId`) to an environment
 * of its own company whose driver is not "local". A policy agent never runs on
 * the server host itself — the pin is where its runs belong, and the run-start
 * recheck refuses a run whose resolved environment is anything else.
 */
export async function boardAssignmentOnlyEnvironmentRefusal(
  dbOrTx: Pick<Db, "select">,
  agent: { companyId: string; defaultEnvironmentId: string | null },
): Promise<AgentWakePolicyRefusalCode | null> {
  const pinnedEnvironmentId = agent.defaultEnvironmentId?.trim() || null;
  if (!pinnedEnvironmentId) return WAKE_POLICY_REFUSAL.noEnvironment;
  const pinned = await dbOrTx
    .select({ driver: environments.driver })
    .from(environments)
    .where(and(eq(environments.id, pinnedEnvironmentId), eq(environments.companyId, agent.companyId)))
    .then((rows) => rows[0] ?? null);
  if (!pinned || pinned.driver === "local") return WAKE_POLICY_REFUSAL.noEnvironment;
  return null;
}
