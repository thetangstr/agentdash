import {
  RUN_FACT_WAKE_REASONS,
  type RunFactOutcome,
  type RunFactWakeReason,
  type RunFacts,
  type RunMeteringStatus,
} from "@paperclipai/shared";

/**
 * AgentDash (OBS-1 / GH #694): build the normalized `runFacts` object persisted
 * on `heartbeat_runs.result_json`. Pure functions only — the heartbeat
 * finalization path and the backfill script both assemble the inputs and call
 * `buildRunFacts`, so the shape and the mappings are tested in one place.
 */

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function parseObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The context wake reasons for wakes a person deliberately aimed at an agent
 * by answering what the agent put in front of them. See the map below.
 */
export const DELIBERATE_PERSON_WAKE_REASONS = {
  bridgeReply: "bridge_reply",
  changesRequested: "changes_requested",
  interactionResolved: "interaction_resolved",
} as const;

/**
 * Server-written `contextSnapshot` key naming who requested the wake ("user",
 * "agent", "system"). enqueueWakeup stamps it from the wake's own actor and
 * never takes it from the caller's context, so a reason in
 * DELIBERATE_PERSON_WAKE_REASONS only counts as a person's when a person
 * actually asked for the wake (POST /agents/:id/wakeup lets an agent pass
 * any `reason` for its own wake).
 */
export const WAKE_REQUESTED_BY_ACTOR_TYPE_KEY = "wakeRequestedByActorType";

/**
 * Server-written `contextSnapshot` key: `true` when the requester asked for
 * this run itself rather than the wake following from someone else's change
 * to work. Set for
 *  - a direct request: `POST /agents/:id/wakeup` or `/heartbeat/invoke`,
 *    where the caller picks `reason` and `source`, so neither says anything
 *    the server vouches for; and
 *  - a self-wake: an agent whose own action wakes itself (it moves, creates
 *    or reassigns its own issue, finishes its own child), whatever reason
 *    the action carries.
 * enqueueWakeup stamps it from `WakeupOptions.requestedDirectly` and the
 * wake's own actor only, never from the caller's context. Coalescing keeps it
 * paired with WAKE_REQUESTED_BY_ACTOR_TYPE_KEY from the same wake.
 */
export const WAKE_REQUESTED_DIRECTLY_KEY = "wakeRequestedDirectly";

/**
 * Context wake reasons that only mean a person's decision when a person
 * requested the wake: a person's answer to the agent (above), and an
 * execution-stage hand-off (review, approval, changes requested). From
 * anyone else they read as the comment wake the ceiling pauses — an agent
 * handing review to another agent is agent-to-agent traffic, not a person
 * aiming work at it.
 */
const PERSON_ONLY_WAKE_REASON_SET: ReadonlySet<string> = new Set([
  ...Object.values(DELIBERATE_PERSON_WAKE_REASONS),
  "execution_review_requested",
  "execution_approval_requested",
  "execution_changes_requested",
]);

/**
 * The wake classes the daily token ceiling pauses: the unattended spend
 * (routine timer wakes, comment wakes, and runs an agent asked for itself —
 * see "agent_requested" in normalizeWakeReason). Everything else a person
 * aimed at the agent, plus work routing, retries and system automation,
 * still runs (heartbeat.ts). The unmetered runaway guard counts the same set
 * (token-ceiling.ts).
 */
export const TOKEN_CEILING_PAUSED_WAKE_CLASSES: ReadonlySet<RunFactWakeReason> = new Set<RunFactWakeReason>([
  "timer",
  "comment",
  "agent_requested",
]);

/**
 * Fine-grained `contextSnapshot.wakeReason` → the coarse label a founder reads.
 * Anything recognized here outranks `invocation_source`, which is coarse enough
 * that a comment wake and a retry both arrive as "automation".
 */
const WAKE_REASON_BY_CONTEXT_REASON: Record<string, RunFactWakeReason> = {
  // The scheduler's own wake (`enqueueWakeup` in tickTimers stamps reason
  // "heartbeat_timer" into contextSnapshot.wakeReason) — without this entry a
  // routine interval wake falls through to "automation" and a timer-driven
  // spend loop reads as deliberate work.
  heartbeat_timer: "timer",
  issue_commented: "comment",
  issue_reopened_via_comment: "comment",
  issue_comment_mentioned: "mention",
  approval_approved: "approval",
  approval_rejected: "approval",
  // An approved connector_send that did not deliver wakes its requester with
  // one of these instead of `approval_approved`; it is still that decision.
  connector_send_failed: "approval",
  connector_send_outcome_unknown: "approval",
  // Issue-tree gate transitions are human decisions, so they bucket with the
  // approval wake rather than generic automation — when a person made them
  // (PERSON_ONLY_WAKE_REASON_SET; from an agent they read as a comment).
  execution_approval_requested: "approval",
  execution_review_requested: "approval",
  execution_changes_requested: "approval",
  issue_assigned: "assignment",
  // A person's own answer to work the agent put in front of them, sent from
  // the bridge or the web. Each is that person's decision on the agent's
  // hand-off, so it buckets with the approval wakes above (an approval
  // decision and an execution-stage "changes requested" are the same kind of
  // act) rather than with a comment: the token ceiling pauses comment wakes
  // as unattended spend, and none of these is unattended. A plain comment,
  // from an agent or a person, stays "comment".
  //   bridge_reply          - the send-back bundle (POST /bridge/work/confirm)
  //   changes_requested     - a person asks for changes on a delivered result
  //                           (POST /issues/:id/request-changes, and the
  //                           requester's change request from the bridge)
  //   interaction_resolved  - a person answers, accepts, rejects or withdraws
  //                           an interaction the agent opened (its questions,
  //                           a confirmation, suggested tasks), from the web,
  //                           the inbox or the bridge
  [DELIBERATE_PERSON_WAKE_REASONS.bridgeReply]: "approval",
  [DELIBERATE_PERSON_WAKE_REASONS.changesRequested]: "approval",
  [DELIBERATE_PERSON_WAKE_REASONS.interactionResolved]: "approval",
  // A human restored a held issue tree — an operator action, not automation.
  issue_tree_restored: "manual",
  process_lost_retry: "retry",
  transient_failure_retry: "retry",
  run_liveness_continuation: "retry",
};

export function normalizeWakeReason(input: {
  invocationSource?: string | null;
  triggerDetail?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
}): RunFactWakeReason {
  const contextReason = readString(input.contextSnapshot?.wakeReason);
  const requestedByActorType = readString(input.contextSnapshot?.[WAKE_REQUESTED_BY_ACTOR_TYPE_KEY]);
  if (requestedByActorType === "agent") {
    // An agent asking for a run of its own is unattended spend: nobody aimed
    // it, and an agent that asks at the end of every run would otherwise keep
    // itself going past its ceiling forever.
    //  - A direct request (the wakeup/invoke routes): the reason and source
    //    are the caller's own words, so a claimed "issue_assigned" or
    //    "process_lost_retry" does not make it one.
    //  - A self-wake: the agent's own action woke the agent itself (moving,
    //    creating or reassigning its own issue, finishing its own child).
    //  - No reason at all: nothing server-side says why this run exists
    //    (a fail-closed backstop).
    // An agent handing an issue to a DIFFERENT agent ("issue_assigned"),
    // checkout, and finished children or blockers of another agent's issue
    // keep their class: work routing between agents keeps flowing.
    if (input.contextSnapshot?.[WAKE_REQUESTED_DIRECTLY_KEY] === true || !contextReason) {
      return "agent_requested";
    }
    // One agent @-mentioning another is agent-to-agent chatter: two chatty
    // agents would keep each other running past both ceilings. A person's
    // mention stays "mention".
    if (contextReason === "issue_comment_mentioned") return "comment";
  }
  if (contextReason && PERSON_ONLY_WAKE_REASON_SET.has(contextReason)) {
    // A person's decision — only when a person asked for the wake. Anyone
    // else claiming the reason (an agent, or a run with no recorded
    // requester) is read as a comment wake, which the ceiling pauses: fail
    // closed.
    return requestedByActorType === "user"
      ? WAKE_REASON_BY_CONTEXT_REASON[contextReason]!
      : "comment";
  }
  if (contextReason) {
    const mapped = WAKE_REASON_BY_CONTEXT_REASON[contextReason];
    if (mapped) return mapped;
    // A recognized context reason that is not in the map is still automation —
    // something in the system woke the run on its own initiative.
    return "automation";
  }
  switch (input.invocationSource) {
    case "timer":
      return "timer";
    case "assignment":
      return "assignment";
    case "automation":
      return "automation";
    case "on_demand":
    default:
      // on_demand is a person or an API client asking for the run directly
      // (an agent asking for one is "agent_requested", above).
      return "manual";
  }
}

/** `liveness_state` is already the "did it produce anything" verdict. */
export function livenessStateToOutcome(
  livenessState: string | null | undefined,
  runStatus?: string | null,
): RunFactOutcome | null {
  switch (livenessState) {
    case "advanced":
    case "completed":
      return "produced";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    case "empty_response":
    case "plan_only":
    case "needs_followup":
      return "no_op";
    default:
      break;
  }
  // Runs that never reached liveness classification still get an outcome.
  if (runStatus === "failed" || runStatus === "timed_out" || runStatus === "cancelled") {
    return "failed";
  }
  return null;
}

export function resolveMeteringStatus(input: {
  /** Stamped by the adapter wrapper (e.g. hermes ledger read) when present. */
  adapterMeteringStatus?: string | null;
  /** Per-run token delta, when any was produced. */
  normalizedUsage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | null;
}): RunMeteringStatus {
  const stamped = readString(input.adapterMeteringStatus);
  if (
    stamped === "metered" ||
    stamped === "adapter_reported" ||
    stamped === "unmetered_no_ledger" ||
    stamped === "unmetered_no_session" ||
    stamped === "unmetered_backfill_ambiguous"
  ) {
    return stamped;
  }
  const usage = input.normalizedUsage;
  if (usage && (usage.inputTokens > 0 || usage.outputTokens > 0 || usage.cachedInputTokens > 0)) {
    return "adapter_reported";
  }
  return "unmetered_no_session";
}

export function buildRunFacts(input: {
  meteringStatus: RunMeteringStatus;
  ledgerSource?: string | null;
  ledgerCertainty?: "certain" | "uncertain" | null;
  servedModel?: string | null;
  servedProvider?: string | null;
  configuredModel?: string | null;
  inputTokens?: number | null;
  cachedInputTokens?: number | null;
  outputTokens?: number | null;
  turns?: number | null;
  toolCalls?: number | null;
  startedAt?: Date | number | null;
  finishedAt?: Date | number | null;
  firstOutputAt?: Date | number | null;
  outcome?: RunFactOutcome | null;
  wakeReason?: RunFactWakeReason;
  now?: Date;
}): RunFacts {
  const startedAt =
    input.startedAt instanceof Date
      ? input.startedAt.getTime()
      : typeof input.startedAt === "number"
        ? input.startedAt
        : null;
  const finishedAt =
    input.finishedAt instanceof Date
      ? input.finishedAt.getTime()
      : typeof input.finishedAt === "number"
        ? input.finishedAt
        : null;
  const firstOutputAt =
    input.firstOutputAt instanceof Date
      ? input.firstOutputAt.getTime()
      : typeof input.firstOutputAt === "number"
        ? input.firstOutputAt
        : null;

  const unmetered =
    input.meteringStatus === "unmetered_no_ledger" ||
    input.meteringStatus === "unmetered_no_session" ||
    input.meteringStatus === "unmetered_backfill_ambiguous";

  return {
    meteringStatus: input.meteringStatus,
    ledgerSource: readString(input.ledgerSource),
    ledgerCertainty:
      input.ledgerCertainty === "certain" || input.ledgerCertainty === "uncertain"
        ? input.ledgerCertainty
        : null,
    servedModel: readString(input.servedModel),
    servedProvider: readString(input.servedProvider),
    configuredModel: readString(input.configuredModel),
    // Missing is not zero: an unmetered run reports nulls, not 0.
    inputTokens: unmetered ? null : readNonNegativeInt(input.inputTokens),
    cachedInputTokens: unmetered ? null : readNonNegativeInt(input.cachedInputTokens),
    outputTokens: unmetered ? null : readNonNegativeInt(input.outputTokens),
    turns: readNonNegativeInt(input.turns),
    toolCalls: readNonNegativeInt(input.toolCalls),
    wallMs:
      startedAt !== null && finishedAt !== null && finishedAt >= startedAt
        ? finishedAt - startedAt
        : null,
    firstOutputMs:
      startedAt !== null && firstOutputAt !== null && firstOutputAt >= startedAt
        ? firstOutputAt - startedAt
        : null,
    outcome: input.outcome ?? null,
    wakeReason:
      input.wakeReason && (RUN_FACT_WAKE_REASONS as readonly string[]).includes(input.wakeReason)
        ? input.wakeReason
        : "manual",
    recordedAt: (input.now ?? new Date()).toISOString(),
  };
}
