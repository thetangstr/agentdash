import { readIssueRecoveryBudget, type IssueRecoveryBudgetUsage } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";

// AgentDash (recovery budget remediation): the issue page is where a person can
// see that automatic recovery for this task stopped, and why, and clear it.
// Before this, the only trace was one comment, and nothing could clear it.
//
// AgentDash (recovery budget, explicit clear — 2026-09-30): the button below is
// the only clear. Changing the status, commenting or reassigning no longer
// clears the block, so the banner says so. Interim, until the one-run permit
// ships: a run a board user's own action starts still goes ahead.

const DIMENSION_LABELS: Record<string, string> = {
  attempts: "automatic retries",
  turns: "turns",
  tokens: "tokens",
  cost: "cost",
  time: "runtime",
};

function formatMinutes(ms: number) {
  const minutes = ms / 60_000;
  return minutes >= 10 ? `${Math.round(minutes)} min` : `${minutes.toFixed(1)} min`;
}

function usageFragments(usage: IssueRecoveryBudgetUsage, limits: IssueRecoveryBudgetUsage | null) {
  const pair = (value: string, limit: string | null) => (limit ? `${value} of ${limit}` : value);
  return [
    `retries ${pair(String(usage.automaticRetries), limits ? String(limits.automaticRetries) : null)}`,
    `turns ${pair(String(usage.providerTurns), limits ? String(limits.providerTurns) : null)}`,
    `tokens ${pair(usage.providerTokens.toLocaleString(), limits ? limits.providerTokens.toLocaleString() : null)}`,
    `runtime ${pair(formatMinutes(usage.runtimeMs), limits ? formatMinutes(limits.runtimeMs) : null)}`,
  ];
}

/**
 * What the "Clear recovery block & retry" toast says. The route wakes the
 * assignee only for `todo` / `in_progress`, so an assigned issue in another
 * status (e.g. `in_review`) is cleared without a retry; say that rather
 * than claiming nobody is assigned.
 */
export function recoveryBudgetClearedToastBody(input: {
  retryQueued: boolean;
  stillBlockedByIssues: boolean;
  status: string;
  hasAgentAssignee: boolean;
}) {
  if (input.stillBlockedByIssues) {
    return "The issue is still blocked by other issues, so no retry was started.";
  }
  if (input.retryQueued) return "The assignee has been woken to retry.";
  if (!input.hasAgentAssignee) return "No agent is assigned to retry this issue.";
  const status = input.status.replace(/_/g, " ");
  return `The issue is ${status}, so no retry was started. Automatic retries are allowed again when work resumes.`;
}

export function IssueRecoveryBudgetBanner({
  executionState,
  isClearing,
  onClear,
}: {
  executionState: unknown;
  isClearing: boolean;
  onClear: () => void;
}) {
  const budget = readIssueRecoveryBudget(executionState);
  if (!budget) return null;

  const dimensions = budget.exhaustedBy.map((dimension) => DIMENSION_LABELS[dimension] ?? dimension);
  return (
    <div
      role="status"
      data-testid="issue-recovery-budget-banner"
      className="space-y-2 rounded-md border border-amber-500/35 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Automatic recovery stopped.</span>
        <span className="text-xs text-amber-900/80 dark:text-amber-100/80">
          {dimensions.length > 0
            ? `The automatic-retry budget ran out (${dimensions.join(", ")}). `
            : "The automatic-retry budget ran out. "}
          No automatic retry starts until a board user clears the block with the button below.
        </span>
      </div>
      <div className="text-xs text-amber-900/80 dark:text-amber-100/80" data-testid="issue-recovery-budget-explicit-clear">
        Changing the status, commenting or reassigning does not clear it. A run you start that way can still go
        ahead, and comments still reach the assignee, but the budget stays exhausted until it is cleared here.
      </div>
      {budget.usage ? (
        <div className="text-xs text-amber-900/80 dark:text-amber-100/80">
          Used: {usageFragments(budget.usage, budget.limits).join(" · ")}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onClear} disabled={isClearing}>
          {isClearing ? "Clearing..." : "Clear recovery block & retry"}
        </Button>
      </div>
    </div>
  );
}
