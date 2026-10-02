import { PendingQuestionRow } from "../components/WorkforceQuestions";
import { useEffect, useState } from "react";
import { Link } from "@/lib/router";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  MessageSquare,
  ShieldQuestion,
  X,
} from "lucide-react";
import type { WaitingOnYouDecision, WaitingOnYouTask } from "@paperclipai/shared";
import { decisionsListLength, useDecisionsCount } from "../hooks/useDecisionsBadge";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { issueUrl } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { PageSkeleton } from "../components/PageSkeleton";
import { cn } from "../lib/utils";
import { DecisionsOtherSources } from "./DecisionsOtherSources";
import { ReviewWaitingRow } from "../components/ReviewWaitingRow";

/**
 * AgentDash: UX-7 (GH #788) — one Decisions page instead of Inbox +
 * Approvals, for every company (one UX, doc/plans/2026-09-30-one-ux.md).
 * The main list comes from
 * GET /assistant/pending-decisions — the same waiting-on-you query Home's
 * block and the assistant's list_pending_decisions read, so the three
 * surfaces can never disagree about what needs the person.
 *
 * Main list = pending approvals + open issues assigned to the person with a
 * manual origin. Issues filed by the machine (routines, evaluations,
 * escalations — any non-manual originKind) group under a collapsed "Other
 * activity" section: they exist, but they are not decisions.
 */

const EMPTY_TEXT =
  "Nothing needs you. Agents ask here before hiring, spending over your limit, or doing anything outside your repo.";

// The badge math the sidebar and this page share lives in
// hooks/useDecisionsBadge — re-exported here so the page stays its most
// readable home.
export { decisionsListLength };

function DecisionRow({ decision }: { decision: WaitingOnYouDecision }) {
  return (
    <li data-testid="decisions-row" className="flex items-start gap-3 px-4 py-3">
      <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      <div className="min-w-0 flex-1 space-y-1">
        <Link
          to={`/approvals/${decision.approvalId}`}
          className="text-sm font-medium leading-5 hover:underline"
        >
          {decision.summary}
        </Link>
        {decision.effects ? (
          <div className="space-y-0.5 text-xs text-muted-foreground">
            <p className="flex items-start gap-1.5">
              <Check className="mt-0.5 h-3 w-3 shrink-0 text-green-600" />
              <span>{decision.effects.approve}</span>
            </p>
            <p className="flex items-start gap-1.5">
              <X className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/70" />
              <span>{decision.effects.reject}</span>
            </p>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          {decision.risk?.level === "high" ? (
            <Badge
              variant="outline"
              className="border-amber-500/40 bg-amber-500/10 px-1.5 py-0 text-[10px] font-medium text-amber-600"
            >
              {decision.risk.reason ?? "higher risk"}
            </Badge>
          ) : null}
          {decision.relatedItem ? (
            <span>
              {decision.relatedItem.identifier ? `${decision.relatedItem.identifier} ` : ""}
              {decision.relatedItem.title ?? ""}
            </span>
          ) : null}
          {decision.waitingSince ? <span>waiting {timeAgo(decision.waitingSince)}</span> : null}
          {!decision.canDecide ? <span>someone else decides this</span> : null}
        </div>
      </div>
      <Link
        to={`/approvals/${decision.approvalId}`}
        className={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0")}
        data-testid="decisions-open"
      >
        Open
      </Link>
    </li>
  );
}

function TaskRow({ task }: { task: WaitingOnYouTask }) {
  return (
    <li data-testid="decisions-task-row" className="flex items-start gap-3 px-4 py-3">
      <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-sky-600" />
      <div className="min-w-0 flex-1">
        <Link
          to={issueUrl({ id: task.issueId, identifier: task.identifier })}
          className="text-sm font-medium leading-5 hover:underline"
        >
          {task.identifier ? <span className="text-muted-foreground">{task.identifier} </span> : null}
          {task.title}
        </Link>
        <div className="text-xs text-muted-foreground">
          Issue assigned to you · {task.status.replace(/_/g, " ")} · updated {timeAgo(task.updatedAt)}
        </div>
      </div>
    </li>
  );
}

export function Decisions() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [showOther, setShowOther] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Decisions" }]);
  }, [setBreadcrumbs]);

  // The same hook the sidebar, mobile and Home badges read, so the header
  // count is exactly the number they show.
  const {
    waiting,
    isLoading,
    error,
    sources: otherSources,
    main: mainCount,
    total: decisionsTotal,
  } = useDecisionsCount(selectedCompanyId);

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground">Select a company first.</p>;
  }
  if (isLoading) {
    return <PageSkeleton variant="approvals" />;
  }

  // The manual/machine split is server-side: `tasksAssignedToYou` is the
  // manual main list, `otherTasksAssignedToYou` the machine-filed group.
  const decisions = waiting?.decisions ?? [];
  const manualTasks = waiting?.tasksAssignedToYou ?? [];
  const otherTasks = waiting?.otherTasksAssignedToYou ?? [];
  const otherTasksTotal = waiting?.otherTasksAssignedToYouTotal ?? otherTasks.length;
  const moreDecisions = (waiting?.total ?? 0) - decisions.length;
  const moreTasks = (waiting?.tasksAssignedToYouTotal ?? 0) - manualTasks.length;

  return (
    <div className="mx-auto w-full max-w-[920px] space-y-4 px-1 py-6 sm:px-4" data-testid="decisions">
      <div className="flex items-center gap-2">
        <ShieldQuestion className="h-5 w-5 text-amber-600" />
        <h1 className="text-xl font-semibold tracking-tight">Decisions</h1>
        {waiting ? (
          <span
            data-testid="decisions-count"
            className="inline-flex min-w-6 items-center justify-center rounded-full bg-muted px-2 py-0.5 text-xs font-semibold tabular-nums"
          >
            {decisionsTotal}
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Couldn't load decisions"}
        </p>
      ) : null}

      {waiting && decisionsTotal === 0 ? (
        <div
          data-testid="decisions-empty"
          className="flex flex-col items-center justify-center rounded-xl border border-border bg-card py-16 text-center"
        >
          <CircleCheck className="mb-3 h-8 w-8 text-muted-foreground/30" />
          <p className="max-w-md px-4 text-sm text-muted-foreground">{EMPTY_TEXT}</p>
        </div>
      ) : null}

      {decisions.length > 0 ? (
        <section className="rounded-xl border border-border bg-card" aria-label="Pending approvals">
          <ul className="divide-y divide-border">
            {decisions.map((decision) => (
              <DecisionRow key={decision.approvalId} decision={decision} />
            ))}
          </ul>
        </section>
      ) : null}
      {moreDecisions > 0 ? (
        <p className="px-1 text-xs text-muted-foreground">
          and {moreDecisions} more waiting approval{moreDecisions === 1 ? "" : "s"}
        </p>
      ) : null}

      {(waiting?.pendingQuestions.length ?? 0) > 0 && <section className="rounded-xl border bg-card" aria-label="Questions waiting for you"><h2 className="px-4 pt-3 text-sm font-semibold">Questions waiting for you</h2><ul className="divide-y">{waiting?.pendingQuestions.map(question => <PendingQuestionRow key={`${selectedCompanyId}:${question.interactionId}`} companyId={selectedCompanyId} question={question}/>)}</ul></section>}
      {(waiting?.pendingQuestionsTotal ?? 0) > (waiting?.pendingQuestions.length ?? 0) && <p className="text-sm">More questions are waiting; answer these to load the next questions.</p>}
      {(waiting?.reviewsWaiting?.length ?? 0) > 0 ? (
        <section className="rounded-xl border border-border bg-card" aria-label="Waiting for your review">
          <header className="border-b border-border px-4 py-2.5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Waiting for your review
            </h2>
          </header>
          <ul className="divide-y divide-border">
            {waiting!.reviewsWaiting!.map((review) => (
              <ReviewWaitingRow key={review.issueId} review={review} testId="decisions-review-row" />
            ))}
          </ul>
        </section>
      ) : null}
      {(waiting?.reviewsWaitingTotal ?? 0) > (waiting?.reviewsWaiting?.length ?? 0) ? (
        <p className="px-1 text-xs text-muted-foreground">
          and {(waiting?.reviewsWaitingTotal ?? 0) - (waiting?.reviewsWaiting?.length ?? 0)} more waiting for review
        </p>
      ) : null}
      {manualTasks.length > 0 ? (
        <section className="rounded-xl border border-border bg-card" aria-label="Assigned to you">
          <header className="border-b border-border px-4 py-2.5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Assigned to you
            </h2>
          </header>
          <ul className="divide-y divide-border">
            {manualTasks.map((task) => (
              <TaskRow key={task.issueId} task={task} />
            ))}
          </ul>
        </section>
      ) : null}
      {moreTasks > 0 ? (
        <p className="px-1 text-xs text-muted-foreground">
          and {moreTasks} more issue{moreTasks === 1 ? "" : "s"} assigned to you —{" "}
          <Link to="/issues?assignee=__me" className="hover:text-foreground hover:underline">
            see all
          </Link>
        </p>
      ) : null}

      <DecisionsOtherSources sources={otherSources} />

      {otherTasks.length > 0 ? (
        <section className="rounded-xl border border-border bg-card" data-testid="decisions-other">
          <button
            type="button"
            onClick={() => setShowOther((v) => !v)}
            aria-expanded={showOther}
            className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            {showOther ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            Other activity
            <span className="normal-case tracking-normal">· {otherTasksTotal}</span>
          </button>
          {showOther ? (
            <ul className="divide-y divide-border border-t border-border">
              {otherTasks.map((task) => (
                <TaskRow key={task.issueId} task={task} />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {waiting && mainCount > 0 ? (
        <p className="px-1 text-xs text-muted-foreground">
          Approving or rejecting on the approval page takes it off this list.
        </p>
      ) : null}
    </div>
  );
}
