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
  // Issue-tree gate transitions are human decisions, so they bucket with the
  // approval wake rather than generic automation.
  execution_approval_requested: "approval",
  execution_review_requested: "approval",
  execution_changes_requested: "approval",
  issue_assigned: "assignment",
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
      // on_demand is a person or an API client asking for the run directly.
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
