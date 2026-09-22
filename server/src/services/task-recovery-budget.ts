export const TASK_RECOVERY_BUDGET_LIMITS = {
  automaticRetries: 1,
  providerTurns: 12,
  providerTokens: 500_000,
  providerCostUsd: 0.25,
  runtimeMs: 5 * 60 * 1_000,
} as const;

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

function tokenTotal(value: unknown): number {
  const usage = object(value);
  const input = number(usage.rawInputTokens ?? usage.inputTokens);
  const cached = number(usage.rawCachedInputTokens ?? usage.cachedInputTokens);
  const output = number(usage.rawOutputTokens ?? usage.outputTokens);
  return Math.floor(input + cached + output);
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
 * Automatic-retry budget for one task (an issue assigned to one agent).
 *
 * AGE-142 (S3 of the AGE-112 dispatch plan): attempts are counted by task
 * scope, not by retry-chain shape. Every terminal run recorded for the same
 * issue+agent is an attempt — including the first, refused dispatch — because
 * the AGE-104 failure showed runs the chain walk never linked (refused and
 * cancelled retries) while the ledger read attempts=0/1. Callers scope the
 * input by context issueId+agent and cap the scan the way the chain walk
 * capped its walk; a budget is about recent history, not archaeology.
 *
 * The counter is the observed attempts, so a single prior run already hits the
 * limit of one automatic retry: the source run spent the allowance, and the
 * next dispatch is the retry it buys. Expiry is therefore strict `>`: one
 * prior run refuses the NEXT dispatch without labelling the last allowed one
 * exhausted, matching the chain rule this replaced (ancestorRuns.length - 1 >=
 * limit) boundary for boundary on a pure retry chain.
 */
export function evaluateTaskRecoveryBudget(
  priorTaskRuns: TaskRecoveryBudgetRun[],
): { usage: TaskRecoveryBudgetUsage; exhaustedBy: TaskRecoveryBudgetDimension[] } {
  const usage = priorTaskRuns.reduce<TaskRecoveryBudgetUsage>((total, run) => {
    const result = object(run.resultJson);
    total.providerTurns += Math.floor(number(result.num_turns ?? result.numTurns));
    total.providerTokens += tokenTotal(run.usageJson);
    total.providerCostUsd += runCost(run.resultJson, run.usageJson);
    total.runtimeMs += runRuntimeMs(run);
    return total;
  }, {
    automaticRetries: Math.max(0, priorTaskRuns.length),
    providerTurns: 0,
    providerTokens: 0,
    providerCostUsd: 0,
    runtimeMs: 0,
  });
  usage.providerCostUsd = Number(usage.providerCostUsd.toFixed(8));

  const exhaustedBy: TaskRecoveryBudgetDimension[] = [];
  if (usage.automaticRetries > TASK_RECOVERY_BUDGET_LIMITS.automaticRetries) exhaustedBy.push("attempts");
  if (usage.providerTurns >= TASK_RECOVERY_BUDGET_LIMITS.providerTurns) exhaustedBy.push("turns");
  if (usage.providerTokens >= TASK_RECOVERY_BUDGET_LIMITS.providerTokens) exhaustedBy.push("tokens");
  if (usage.providerCostUsd >= TASK_RECOVERY_BUDGET_LIMITS.providerCostUsd) exhaustedBy.push("cost");
  if (usage.runtimeMs >= TASK_RECOVERY_BUDGET_LIMITS.runtimeMs) exhaustedBy.push("time");

  return { usage, exhaustedBy };
}

export function formatTaskRecoveryBudgetUsage(usage: TaskRecoveryBudgetUsage): string {
  return [
    `attempts=${usage.automaticRetries}/${TASK_RECOVERY_BUDGET_LIMITS.automaticRetries}`,
    `turns=${usage.providerTurns}/${TASK_RECOVERY_BUDGET_LIMITS.providerTurns}`,
    `tokens=${usage.providerTokens}/${TASK_RECOVERY_BUDGET_LIMITS.providerTokens}`,
    `costUsd=${usage.providerCostUsd.toFixed(6)}/${TASK_RECOVERY_BUDGET_LIMITS.providerCostUsd.toFixed(2)}`,
    `runtimeMs=${usage.runtimeMs}/${TASK_RECOVERY_BUDGET_LIMITS.runtimeMs}`,
  ].join(", ");
}
