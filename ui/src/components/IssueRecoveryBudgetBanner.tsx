import { readIssueRecoveryBudget, type IssueRecoveryBudgetUsage } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";

// AgentDash (recovery budget remediation): the issue page is where a person can
// see that automatic recovery for this task stopped, and why, and clear it.
// Before this, the only trace was one comment, and nothing could clear it.
//
// AgentDash (recovery budget, permit + explicit clear — 2026-09-30 founder
// decision): there are two ways past the block, and the banner names both.
// The button below clears it. A board user can instead authorize exactly one
// run through the human-control plane (task_recovery.remediate); that run
// cannot continue on its own. Changing the status, commenting or reassigning
// does not clear the block, and the run such an action would start is
// refused too.

const DIMENSION_LABELS: Record<string, string> = {
  attempts: "automatic retries",
  turns: "turns",
  tokens: "tokens",
  cost: "cost",
  time: "runtime",
};

/** A still-unused one-run authorization on the marker, if there is one. */
export function authorizedRecoveryRun(executionState: unknown): { expiresAt: string | null } | null {
  const record = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const remediation = record(record(record(executionState)?.recoveryBudget)?.remediation);
  if (!remediation || remediation.status !== "authorized") return null;
  return { expiresAt: typeof remediation.expiresAt === "string" ? remediation.expiresAt : null };
}

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

  const authorized = authorizedRecoveryRun(executionState);
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
          No run starts on this issue until a board user clears the block, or authorizes exactly one run.
        </span>
      </div>
      <div className="text-xs text-amber-900/80 dark:text-amber-100/80" data-testid="issue-recovery-budget-explicit-clear">
        Changing the status, commenting or reassigning does not clear it. The run that would start is refused too.
        Comments stay on the issue for the next permitted run. To go on, clear the block with the button below
        (automatic retries resume), or authorize one run through the human-control plane
        (task_recovery.remediate): that run cannot continue on its own, and the block stays.
      </div>
      {authorized ? (
        <div className="text-xs font-medium" data-testid="issue-recovery-budget-authorized-run">
          One run is authorized and waiting to start
          {authorized.expiresAt ? ` (the authorization expires ${new Date(authorized.expiresAt).toLocaleString()})` : ""}.
        </div>
      ) : null}
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
