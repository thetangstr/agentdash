import { agentRecoveryBudgetConfigSchema } from "@paperclipai/shared";

/**
 * Default automatic-recovery limits. An agent may override any of them through
 * `runtimeConfig.recoveryBudget` (validated by agentRecoveryBudgetConfigSchema);
 * see resolveTaskRecoveryBudgetLimits.
 */
export const TASK_RECOVERY_BUDGET_LIMITS = {
  automaticRetries: 1,
  providerTurns: 12,
  providerTokens: 500_000,
  providerCostUsd: 0.25,
  runtimeMs: 5 * 60 * 1_000,
} as const;

export type TaskRecoveryBudgetLimits = {
  automaticRetries: number;
  providerTurns: number;
  providerTokens: number;
  providerCostUsd: number;
  runtimeMs: number;
};

/**
 * Upper bound on how many prior task runs feed the recovery budget.
 *
 * The chain walk this replaces capped its depth at 50; the scope query keeps
 * that ceiling so a task with long history cannot turn the claim-time budget
 * check into an unbounded scan. Newest-first: the cap keeps the most recent
 * attempts, which is the history a retry decision is about.
 */
export const TASK_RECOVERY_SCOPE_SCAN_CAP = 50;

export type TaskRecoveryBudgetDimension = "attempts" | "turns" | "tokens" | "cost" | "time";

export type TaskRecoveryBudgetUsage = {
  automaticRetries: number;
  providerTurns: number;
  providerTokens: number;
  providerCostUsd: number;
  runtimeMs: number;
};

export type TaskRecoveryBudgetRun = {
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
  usageJson: unknown;
  resultJson: unknown;
};

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function number(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

// Cached input tokens are deliberately left out: a resumed session re-reads
// its whole context from cache on every turn, so counting cache reads made a
// single long run (mostly cache reads) look like a
// runaway. Fresh input plus output is the spend a retry adds.
function tokenTotal(value: unknown): number {
  const usage = object(value);
  const input = number(usage.rawInputTokens ?? usage.inputTokens);
  const output = number(usage.rawOutputTokens ?? usage.outputTokens);
  return Math.floor(input + output);
}

function runCost(value: unknown, usageValue: unknown): number {
  const result = object(value);
  const usage = object(usageValue);
  return number(
    result.total_cost_usd ??
      result.cost_usd ??
      result.costUsd ??
      usage.costUsd ??
      usage.cost_usd,
  );
}

function runRuntimeMs(run: TaskRecoveryBudgetRun): number {
  const started = run.startedAt ? new Date(run.startedAt).getTime() : Number.NaN;
  const finished = run.finishedAt ? new Date(run.finishedAt).getTime() : Number.NaN;
  if (Number.isFinite(started) && Number.isFinite(finished) && finished >= started) {
    return finished - started;
  }
  const result = object(run.resultJson);
  return number(result.duration_ms ?? result.durationMs);
}

/**
 * Effective limits for one agent: the defaults, overridden field by field by
 * `runtimeConfig.recoveryBudget`, with the runtime ceiling raised to at least
 * the adapter's configured per-run timeout. A retry the adapter is allowed to
 * run to its own timeout must not be refused for having done so; the adapter
 * timeout stays the per-run ceiling.
 *
 * An override that fails validation (written before the schema existed, or
 * straight to the database) is ignored as a whole rather than half-applied.
 */
export function resolveTaskRecoveryBudgetLimits(input: {
  runtimeConfig: unknown;
  adapterTimeoutMs?: number | null;
}): { limits: TaskRecoveryBudgetLimits; invalidOverride: boolean } {
  const limits: TaskRecoveryBudgetLimits = { ...TASK_RECOVERY_BUDGET_LIMITS };
  let invalidOverride = false;
  const rawOverride = object(input.runtimeConfig).recoveryBudget;
  if (rawOverride !== undefined && rawOverride !== null) {
    const parsed = agentRecoveryBudgetConfigSchema.safeParse(rawOverride);
    if (parsed.success) {
      for (const [key, value] of Object.entries(parsed.data)) {
        if (typeof value === "number") limits[key as keyof TaskRecoveryBudgetLimits] = value;
      }
    } else {
      invalidOverride = true;
    }
  }
  const adapterTimeoutMs = input.adapterTimeoutMs ?? 0;
  if (Number.isFinite(adapterTimeoutMs) && adapterTimeoutMs > limits.runtimeMs) {
    limits.runtimeMs = Math.floor(adapterTimeoutMs);
  }
  return { limits, invalidOverride };
}

/**
 * Automatic-retry budget for one task (an issue assigned to one agent).
 *
 * The ledger is the task's automatic recovery runs only: dispatches linked to
 * a predecessor by retryOfRunId / a continuation link. The source run (the
 * assignment, a human comment, any unlinked dispatch) is not recovery and is
 * not counted, so one long first run no longer exhausts the budget before the
 * first retry runs. Callers scope the input by context
 * issueId+agent, keep only linked runs recorded since the last human clear,
 * and cap the scan (AGE-142: counting by task scope, not chain shape, so
 * refused and cancelled linked retries still count as attempts).
 *
 * `automaticRetries` is the number of automatic retries already spent, so the
 * dispatch being judged is retry number `automaticRetries + 1`; it is refused
 * once the spent count reaches the limit. With the default limit of 1 the
 * first retry runs and the second is refused, the same boundary as before on
 * a pure retry chain.
 */
export function evaluateTaskRecoveryBudget(
  priorAutomaticRuns: TaskRecoveryBudgetRun[],
  limits: TaskRecoveryBudgetLimits = TASK_RECOVERY_BUDGET_LIMITS,
): { usage: TaskRecoveryBudgetUsage; exhaustedBy: TaskRecoveryBudgetDimension[] } {
  const usage = priorAutomaticRuns.reduce<TaskRecoveryBudgetUsage>((total, run) => {
    const result = object(run.resultJson);
    total.providerTurns += Math.floor(number(result.num_turns ?? result.numTurns));
    total.providerTokens += tokenTotal(run.usageJson);
    total.providerCostUsd += runCost(run.resultJson, run.usageJson);
    total.runtimeMs += runRuntimeMs(run);
    return total;
  }, {
    automaticRetries: Math.max(0, priorAutomaticRuns.length),
    providerTurns: 0,
    providerTokens: 0,
    providerCostUsd: 0,
    runtimeMs: 0,
  });
  usage.providerCostUsd = Number(usage.providerCostUsd.toFixed(8));

  const exhaustedBy: TaskRecoveryBudgetDimension[] = [];
  if (usage.automaticRetries >= limits.automaticRetries) exhaustedBy.push("attempts");
  if (usage.providerTurns >= limits.providerTurns) exhaustedBy.push("turns");
  if (usage.providerTokens >= limits.providerTokens) exhaustedBy.push("tokens");
  if (usage.providerCostUsd >= limits.providerCostUsd) exhaustedBy.push("cost");
  if (usage.runtimeMs >= limits.runtimeMs) exhaustedBy.push("time");

  return { usage, exhaustedBy };
}

export function formatTaskRecoveryBudgetUsage(
  usage: TaskRecoveryBudgetUsage,
  limits: TaskRecoveryBudgetLimits = TASK_RECOVERY_BUDGET_LIMITS,
): string {
  return [
    `attempts=${usage.automaticRetries}/${limits.automaticRetries}`,
    `turns=${usage.providerTurns}/${limits.providerTurns}`,
    `tokens=${usage.providerTokens}/${limits.providerTokens}`,
    `costUsd=${usage.providerCostUsd.toFixed(6)}/${limits.providerCostUsd.toFixed(2)}`,
    `runtimeMs=${usage.runtimeMs}/${limits.runtimeMs}`,
  ].join(", ");
}
