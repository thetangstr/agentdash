import { useState } from "react";
import { readIssueRecoveryBudget, type IssueRecoveryBudgetUsage } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// AgentDash (recovery budget remediation): the issue page is where a person can
// see that automatic recovery for this task stopped, and why, and clear it.
// Before this, the only trace was one comment, and nothing could clear it.
//
// AgentDash (recovery budget, permit + explicit clear — 2026-09-30 founder
// decision): there are two ways past the block, and the banner offers both.
// "Clear recovery block & retry" removes it. "Authorize one run" lets exactly
// one run go ahead while the block stays (GH #891: a signed-in board user,
// through the same server operation the board-key human-control plane uses).
// That run cannot continue on its own. Changing the status, commenting or
// reassigning does not clear the block, and the run such an action would
// start is refused too.

const DIMENSION_LABELS: Record<string, string> = {
  attempts: "automatic retries",
  turns: "turns",
  tokens: "tokens",
  cost: "cost",
  time: "runtime",
};

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function remediationOf(executionState: unknown) {
  return record(record(record(executionState)?.recoveryBudget)?.remediation);
}

/** A still-unused one-run authorization on the marker, if there is one. */
export function authorizedRecoveryRun(executionState: unknown): { expiresAt: string | null } | null {
  const remediation = remediationOf(executionState);
  if (!remediation || remediation.status !== "authorized") return null;
  return { expiresAt: typeof remediation.expiresAt === "string" ? remediation.expiresAt : null };
}

/**
 * GH #891: an authorization that ended without its run starting (stopped by
 * another start check, or expired), so the banner can say so instead of
 * "waiting to start" — and invite a fresh authorization.
 */
export function unusedRecoveryRunOutcome(executionState: unknown): { status: "denied" | "expired"; reason: string | null } | null {
  const remediation = remediationOf(executionState);
  if (!remediation || (remediation.status !== "denied" && remediation.status !== "expired")) return null;
  return {
    status: remediation.status,
    reason: typeof remediation.denialReason === "string" ? remediation.denialReason : null,
  };
}

/** What the server's preview of "Authorize one run" returns (the readback). */
export type RecoveryRunAuthorizationPreview = {
  readback: { context: Record<string, unknown> };
  preconditions: Record<string, unknown>;
};

function previewAgentName(preview: RecoveryRunAuthorizationPreview | null): string | null {
  const issue = record(preview?.readback.context.issue);
  return typeof issue?.assigneeAgentName === "string" ? issue.assigneeAgentName : null;
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

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function IssueRecoveryBudgetBanner({
  executionState,
  isClearing,
  onClear,
  onPreviewAuthorizeRun,
  onAuthorizeRun,
}: {
  executionState: unknown;
  isClearing: boolean;
  onClear: () => void;
  /** Fetch the server's readback for "Authorize one run". Omit to hide the action. */
  onPreviewAuthorizeRun?: () => Promise<RecoveryRunAuthorizationPreview>;
  /** Authorize exactly one run against the reviewed preconditions. */
  onAuthorizeRun?: (preconditions: Record<string, unknown>) => Promise<void>;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [preview, setPreview] = useState<RecoveryRunAuthorizationPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const budget = readIssueRecoveryBudget(executionState);
  if (!budget) return null;

  const authorized = authorizedRecoveryRun(executionState);
  const unused = authorized ? null : unusedRecoveryRunOutcome(executionState);
  const dimensions = budget.exhaustedBy.map((dimension) => DIMENSION_LABELS[dimension] ?? dimension);
  const canAuthorize = Boolean(onPreviewAuthorizeRun && onAuthorizeRun);

  async function openAuthorizeDialog() {
    if (!onPreviewAuthorizeRun) return;
    setDialogOpen(true);
    setPreview(null);
    setDialogError(null);
    setLoadingPreview(true);
    try {
      setPreview(await onPreviewAuthorizeRun());
    } catch (error) {
      setDialogError(errorMessage(error, "Could not load what this would authorize."));
    } finally {
      setLoadingPreview(false);
    }
  }

  async function confirmAuthorize() {
    if (!onAuthorizeRun || !preview) return;
    setAuthorizing(true);
    setDialogError(null);
    try {
      await onAuthorizeRun(preview.preconditions);
      setDialogOpen(false);
    } catch (error) {
      setDialogError(errorMessage(error, "Could not authorize the run."));
    } finally {
      setAuthorizing(false);
    }
  }

  const agentName = previewAgentName(preview);
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
        Comments stay on the issue for the next permitted run. To go on, either clear the block (automatic retries
        resume), or authorize one run: that single run goes ahead, cannot continue on its own, and the block stays.
        Authorizing needs a company admin or someone who manages this issue's agent.
      </div>
      {authorized ? (
        <div className="text-xs font-medium" data-testid="issue-recovery-budget-authorized-run">
          One run is authorized and waiting to start
          {authorized.expiresAt ? ` (the authorization expires ${new Date(authorized.expiresAt).toLocaleString()})` : ""}.
        </div>
      ) : null}
      {unused ? (
        <div className="text-xs font-medium" data-testid="issue-recovery-budget-unused-run">
          {unused.status === "expired"
            ? "The last authorized run did not start before its authorization expired."
            : `The last authorized run did not start${unused.reason ? ` (${unused.reason})` : ""}.`}{" "}
          Authorize again to try once more.
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
        {canAuthorize ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => void openAuthorizeDialog()}
            disabled={Boolean(authorized) || isClearing}
            data-testid="issue-recovery-budget-authorize-run"
          >
            Authorize one run
          </Button>
        ) : null}
      </div>
      {canAuthorize ? (
        <Dialog open={dialogOpen} onOpenChange={(open) => { if (!authorizing) setDialogOpen(open); }}>
          <DialogContent data-testid="issue-recovery-budget-authorize-dialog">
            <DialogHeader>
              <DialogTitle>Authorize one run?</DialogTitle>
              <DialogDescription>
                {agentName ? `${agentName} gets` : "The assigned agent gets"} exactly one run on this issue. The
                recovery block stays: when that run ends, nothing else starts until someone authorizes another run or
                clears the block.
              </DialogDescription>
            </DialogHeader>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li>The run still has to pass the usual checks (agent paused, budget, run quota, blockers).</li>
              <li>If it has not started within 15 minutes, the authorization expires.</li>
              <li>This is recorded in the issue's activity as authorized by you.</li>
            </ul>
            {loadingPreview ? <p className="text-sm text-muted-foreground">Checking the issue…</p> : null}
            {dialogError ? (
              <p className="text-sm text-destructive" role="alert" data-testid="issue-recovery-budget-authorize-error">
                {dialogError}
              </p>
            ) : null}
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={authorizing}>
                Cancel
              </Button>
              <Button
                onClick={() => void confirmAuthorize()}
                disabled={!preview || loadingPreview || authorizing}
                data-testid="issue-recovery-budget-authorize-confirm"
              >
                {authorizing ? "Authorizing..." : "Authorize one run"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
