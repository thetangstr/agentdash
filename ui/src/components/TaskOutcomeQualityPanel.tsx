import type { DashboardTaskOutcomeQuality } from "@paperclipai/shared";
import { CheckCircle2, CircleDollarSign, ClipboardCheck, AlertTriangle } from "lucide-react";
import { cn, formatCents } from "../lib/utils";

function tone(quality: DashboardTaskOutcomeQuality) {
  if (quality.issuesInScope === 0) {
    return "border-muted-foreground/25 bg-muted/40 text-foreground";
  }
  if (quality.reviewedIssues > 0 && quality.acceptanceRatePercent < 50) {
    return "border-red-500/30 bg-red-500/10 text-red-900 dark:text-red-200";
  }
  if (
    quality.dodCoveragePercent < 80
    || quality.greenRunsWithOpenTasks > 0
    || quality.greenRunsPendingReview > 0
    || quality.unreviewedDoneIssues > 0
  ) {
    return "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200";
  }
  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200";
}

function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string | number;
  detail?: string;
}) {
  return (
    <div className="rounded-md border border-current/15 bg-background/50 px-2.5 py-2">
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      <p className="text-[11px] font-medium opacity-85">{label}</p>
      {detail ? <p className="mt-0.5 text-[11px] opacity-70">{detail}</p> : null}
    </div>
  );
}

export function TaskOutcomeQualityPanel({ quality }: { quality: DashboardTaskOutcomeQuality }) {
  // GH #918: the spend fields are null (never zeroed) for members who cannot
  // read the cost routes — the stat says so instead of inventing a figure.
  const spendRestricted = quality.issueLinkedTokens === null;
  const spendPerAccepted = quality.spendPerAcceptedIssueCents === null
    ? spendRestricted ? "—" : "n/a"
    : formatCents(quality.spendPerAcceptedIssueCents);
  const openTaskRunLabel = quality.greenRunsWithOpenTasks === 1
    ? "1 finished run left a task open"
    : `${quality.greenRunsWithOpenTasks} finished runs left tasks open`;
  const hasSecondarySignals =
    quality.greenRunsWithOpenTasks > 0 ||
    quality.greenRunsPendingReview > 0 ||
    quality.unreviewedDoneIssues > 0 ||
    quality.escalatedIssues > 0 ||
    (quality.issueLinkedSpendCents ?? 0) > 0;

  return (
    <section className={cn("rounded-lg border px-4 py-3", tone(quality))}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ClipboardCheck className="h-4 w-4 shrink-0" />
            <h3 className="text-sm font-medium">Accepted work</h3>
          </div>
          <p className="mt-1 text-xs opacity-80">
            Tasks accepted in the last {quality.windowDays} days — not just runs that finished.
          </p>
        </div>
        <div className="text-right tabular-nums">
          <p className="text-xl font-semibold">{quality.acceptanceRatePercent}%</p>
          <p className="text-[11px] opacity-80">
            {quality.passedIssues}/{quality.reviewedIssues} accepted
          </p>
        </div>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <Stat
          label="Tasks with acceptance criteria"
          value={`${quality.dodCoveragePercent}%`}
          detail={`${quality.issuesWithDefinitionOfDone}/${quality.issuesInScope} tasks`}
        />
        <Stat
          label="Spend per accepted task"
          value={spendPerAccepted}
          // AgentDash (batch 3): input + output only, the same figure the
          // Costs page reports; cached reads are listed separately rather
          // than folded into the headline number.
          detail={
            spendRestricted
              ? "Visible to administrators only"
              : `${quality.issueLinkedTokens!.toLocaleString()} issue-linked tokens` +
                ((quality.issueLinkedCachedTokens ?? 0) > 0
                  ? ` · ${quality.issueLinkedCachedTokens!.toLocaleString()} cached reads`
                  : "")
          }
        />
        <Stat
          label="Reviewed tasks"
          value={quality.reviewedIssues}
          detail={`${quality.failedIssues} failed / ${quality.revisionRequestedIssues} sent back`}
        />
      </div>

      {hasSecondarySignals ? (
        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
          {quality.greenRunsWithOpenTasks > 0 ? (
            <div className="flex items-center gap-1.5 rounded-md border border-current/15 bg-background/50 px-2 py-1.5">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>{openTaskRunLabel}</span>
            </div>
          ) : null}
          {quality.greenRunsPendingReview > 0 ? (
            <div className="flex items-center gap-1.5 rounded-md border border-current/15 bg-background/50 px-2 py-1.5">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>{quality.greenRunsPendingReview} finished runs waiting for review</span>
            </div>
          ) : null}
          {quality.unreviewedDoneIssues > 0 ? (
            <div className="flex items-center gap-1.5 rounded-md border border-current/15 bg-background/50 px-2 py-1.5">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              <span>{quality.unreviewedDoneIssues} tasks marked done without a review</span>
            </div>
          ) : null}
          {quality.escalatedIssues > 0 ? (
            <div className="flex items-center gap-1.5 rounded-md border border-current/15 bg-background/50 px-2 py-1.5">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>{quality.escalatedIssues} tasks need a decision</span>
            </div>
          ) : null}
          {(quality.issueLinkedSpendCents ?? 0) > 0 ? (
            <div className="flex items-center gap-1.5 rounded-md border border-current/15 bg-background/50 px-2 py-1.5">
              <CircleDollarSign className="h-3.5 w-3.5 shrink-0" />
              <span>{formatCents(quality.issueLinkedSpendCents!)} issue-linked spend</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
