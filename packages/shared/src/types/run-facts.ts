/**
 * AgentDash (OBS-1 / GH #694): the honest per-run record.
 *
 * `runFacts` is a normalized object written into `heartbeat_runs.result_json`
 * at run finalization (and by the OBS-1 backfill for the last 30 days). It is
 * deliberately a jsonb object, not columns — promote a field only when a query
 * needs to index it.
 *
 * The honesty contract: a run whose metering failed says so
 * (`meteringStatus` = `unmetered_*`) instead of recording 0 tokens. Consumers
 * must treat `null` token fields as unknown, never as zero.
 */

export const RUN_METERING_STATUSES = [
  /** Tokens came from the adapter's own ledger (Hermes `session_model_usage`). */
  "metered",
  /** The adapter reported usage natively in its result. */
  "adapter_reported",
  /** The metering source (ledger file) was missing or unreadable. */
  "unmetered_no_ledger",
  /** The ledger was readable but held no row for this run's session. */
  "unmetered_no_session",
] as const;
export type RunMeteringStatus = (typeof RUN_METERING_STATUSES)[number];

export const RUN_FACT_OUTCOMES = [
  /** The run produced concrete evidence (`advanced`/`completed` liveness). */
  "produced",
  /** The run ended cleanly but produced nothing (`needs_followup`, `empty_response`, `plan_only`). */
  "no_op",
  /** The run declared or hit a blocker. */
  "blocked",
  /** The run did not complete successfully. */
  "failed",
] as const;
export type RunFactOutcome = (typeof RUN_FACT_OUTCOMES)[number];

export const RUN_FACT_WAKE_REASONS = [
  "timer",
  "assignment",
  "comment",
  "mention",
  "approval",
  "automation",
  "retry",
  "manual",
] as const;
export type RunFactWakeReason = (typeof RUN_FACT_WAKE_REASONS)[number];

export interface RunFacts {
  meteringStatus: RunMeteringStatus;
  /** Model/provider that actually served the run (adapter ledger or report). */
  servedModel: string | null;
  servedProvider: string | null;
  /** Model the run was configured to use, resolved before dispatch. */
  configuredModel: string | null;
  /** Per-run deltas — null when unmetered (unknown, not zero). */
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  /** Model API calls in this run, where the adapter reports them. */
  turns: number | null;
  /** Tool invocations in this run, where the adapter reports them. */
  toolCalls: number | null;
  /** finishedAt - startedAt. */
  wallMs: number | null;
  /** startedAt → first stdout/stderr byte; null for silent-to-exit adapters and backfilled runs. */
  firstOutputMs: number | null;
  outcome: RunFactOutcome | null;
  wakeReason: RunFactWakeReason;
  /** ISO timestamp of when the facts were recorded. */
  recordedAt: string;
}
