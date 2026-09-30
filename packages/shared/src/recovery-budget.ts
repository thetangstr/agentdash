/**
 * AgentDash (recovery budget remediation): the automatic-recovery budget
 * marker the heartbeat writes to `issues.execution_state.recoveryBudget` when
 * automatic retries for a task run out. Shared so the server gates and the
 * issue page read the same shape.
 */

export const ISSUE_RECOVERY_BUDGET_EXHAUSTED_ACTION = "issue.recovery_budget_exhausted";
export const ISSUE_RECOVERY_BUDGET_CLEARED_ACTION = "issue.recovery_budget_cleared";

/** What cleared the marker. Every trigger is a human (board) action. */
export type IssueRecoveryBudgetClearTrigger =
  | "status_change"
  | "reopen_comment"
  | "reassign"
  | "explicit_action";

export interface IssueRecoveryBudgetUsage {
  automaticRetries: number;
  providerTurns: number;
  providerTokens: number;
  providerCostUsd: number;
  runtimeMs: number;
}

export interface IssueRecoveryBudgetState {
  status: "exhausted";
  exhaustedBy: string[];
  usage: IssueRecoveryBudgetUsage | null;
  limits: IssueRecoveryBudgetUsage | null;
  exhaustedAt: string | null;
  sourceRunId: string | null;
  refusedRunId: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readUsage(value: unknown): IssueRecoveryBudgetUsage | null {
  const usage = record(value);
  if (!usage) return null;
  return {
    automaticRetries: finiteNumber(usage.automaticRetries),
    providerTurns: finiteNumber(usage.providerTurns),
    providerTokens: finiteNumber(usage.providerTokens),
    providerCostUsd: finiteNumber(usage.providerCostUsd),
    runtimeMs: finiteNumber(usage.runtimeMs),
  };
}

/**
 * The exhausted recovery-budget marker on an issue's raw execution state, or
 * null when there is none. Tolerates the shapes older releases wrote.
 */
export function readIssueRecoveryBudget(executionState: unknown): IssueRecoveryBudgetState | null {
  const budget = record(record(executionState)?.recoveryBudget);
  if (!budget || budget.status !== "exhausted") return null;
  return {
    status: "exhausted",
    exhaustedBy: Array.isArray(budget.exhaustedBy)
      ? budget.exhaustedBy.filter((value): value is string => typeof value === "string")
      : [],
    usage: readUsage(budget.usage),
    limits: readUsage(budget.limits),
    exhaustedAt: optionalString(budget.exhaustedAt),
    sourceRunId: optionalString(budget.sourceRunId),
    refusedRunId: optionalString(budget.refusedRunId),
  };
}
