import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { AlertTriangle, Bot, HelpCircle, ShieldAlert, UserPlus, X, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import type { HeartbeatRun } from "@paperclipai/shared";
import type { InboxItem } from "../api/stewardships";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { approvalAsk } from "../lib/approval-ask";
import { Button } from "@/components/ui/button";
import type { DecisionsOtherSourcesData } from "../hooks/useDecisionsSources";

/**
 * AgentDash: one UX (doc/plans/2026-09-30-one-ux.md) — the sections Decisions
 * shows beyond its main list: the item sources the MK Inbox showed, and the
 * failed runs the old Inbox listed. The data (and how each source decides it
 * is absent) lives in hooks/useDecisionsSources, which the badges read too.
 */

// Re-exported so the page's tests and callers keep one import path.
export {
  decisionsSourceKeys,
  failedRunItemKey,
  loadSource,
  resetSourceFailureStreaks,
  sourceRefetchInterval,
  SOURCE_MAX_BACKOFF_MS,
  SOURCE_POLL_MS,
  useDecisionsOtherSources,
  visibleFailedRuns,
  type DecisionsOtherSourcesData,
} from "../hooks/useDecisionsSources";

export function stewardItemSummary(item: InboxItem): string {
  const who = item.requestingAgent?.name ?? "Your agent";
  const ask = approvalAsk(item.type, item.payload);
  return ask ? `${who} ${ask}` : `${who}: ${item.type.replace(/_/g, " ")}`;
}

function Section({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-card" aria-label={label} data-testid={testId}>
      <header className="border-b border-border px-4 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</h2>
      </header>
      <ul className="divide-y divide-border">{children}</ul>
    </section>
  );
}

function Row({
  icon,
  to,
  title,
  detail,
  testId,
}: {
  icon: ReactNode;
  to: string;
  title: string;
  detail?: string | null;
  testId: string;
}) {
  return (
    <li data-testid={testId} className="flex items-start gap-3 px-4 py-3">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1">
        <Link to={to} className="text-sm font-medium leading-5 hover:underline">
          {title}
        </Link>
        {detail ? <div className="text-xs text-muted-foreground">{detail}</div> : null}
      </div>
    </li>
  );
}


function firstLine(value: string | null | undefined): string | null {
  const line = (value ?? "").split("\n").map((part) => part.trim()).find(Boolean);
  return line ?? null;
}

/** The failure reason the old Inbox showed: the error, else stderr, else a generic line. */
export function runFailureMessage(run: Pick<HeartbeatRun, "error" | "stderrExcerpt">): string {
  return firstLine(run.error) ?? firstLine(run.stderrExcerpt) ?? "Run exited with an error.";
}

function FailedRunRow({
  run,
  agentName,
  onDismiss,
}: {
  run: HeartbeatRun;
  agentName: string | null;
  onDismiss: () => void;
}) {
  return (
    <li data-testid="decisions-failed-run-row" className="flex items-start gap-3 px-4 py-3">
      <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <Link to={`/agents/${run.agentId}/runs/${run.id}`} className="text-sm font-medium leading-5 hover:underline">
          {agentName ? `${agentName}'s last run failed` : "An agent's last run failed"}
        </Link>
        <div className="text-xs text-muted-foreground">
          {[runFailureMessage(run), `${run.status === "timed_out" ? "timed out" : "failed"} ${timeAgo(run.createdAt)}`].join(" · ")}
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="shrink-0"
        onClick={onDismiss}
        data-testid="decisions-failed-run-dismiss"
        aria-label="Dismiss this failed run"
      >
        <X className="mr-1 h-3.5 w-3.5" />
        Dismiss
      </Button>
    </li>
  );
}

export function DecisionsOtherSources({ sources }: { sources: DecisionsOtherSourcesData }) {
  const { agentName, stewardItems, overrideCount, questions, sends, joins, failedRuns, dismissFailedRun } = sources;
  // Agent names for the failed-run rows; the same list query other pages use.
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(sources.companyId ?? ""),
    queryFn: () => agentsApi.list(sources.companyId!),
    enabled: !!sources.companyId && failedRuns.length > 0,
  });
  const agentNameById = new Map((agents ?? []).map((agent) => [agent.id, agent.name]));

  return (
    <>
      {stewardItems.length > 0 ? (
        <Section label={agentName ? `${agentName} is waiting on you` : "Your agent is waiting on you"} testId="decisions-steward">
          {stewardItems.map((item) => (
            <Row
              key={item.approvalId}
              testId="decisions-steward-row"
              icon={<Bot className="h-4 w-4 text-amber-600" />}
              to={`/approvals/${item.approvalId}`}
              title={stewardItemSummary(item)}
              detail={[
                item.risk?.reason ?? null,
                item.sourceIssues[0] ? `${item.sourceIssues[0].identifier} ${item.sourceIssues[0].title}` : null,
                `waiting ${timeAgo(item.createdAt)}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            />
          ))}
        </Section>
      ) : null}

      {questions.length > 0 ? (
        <Section label="Questions from your agent" testId="decisions-questions">
          {questions.map((question) => (
            <Row
              key={question.id}
              testId="decisions-question-row"
              icon={<HelpCircle className="h-4 w-4 text-sky-600" />}
              to="/my-agent"
              title={question.question}
              detail={question.createdAt ? `asked ${timeAgo(question.createdAt)}` : null}
            />
          ))}
        </Section>
      ) : null}

      {sends.length > 0 ? (
        <Section label="Outside writes to confirm" testId="decisions-connector-sends">
          {sends.map((send) => (
            <Row
              key={send.id}
              testId="decisions-connector-send-row"
              icon={<AlertTriangle className="h-4 w-4 text-amber-600" />}
              to="/company/settings"
              title={`${send.provider} ${send.operation} ${send.objectType}: outcome unknown`}
              detail={[send.reason, `sent ${timeAgo(send.executedAt)}`].filter(Boolean).join(" · ")}
            />
          ))}
        </Section>
      ) : null}

      {failedRuns.length > 0 ? (
        <Section label="Failed runs" testId="decisions-failed-runs">
          {failedRuns.map((run) => (
            <FailedRunRow
              key={run.id}
              run={run}
              agentName={agentNameById.get(run.agentId) ?? null}
              onDismiss={() => dismissFailedRun(run)}
            />
          ))}
        </Section>
      ) : null}

      {joins.length > 0 ? (
        <Section label="Join requests" testId="decisions-join-requests">
          <Row
            testId="decisions-join-request-row"
            icon={<UserPlus className="h-4 w-4 text-sky-600" />}
            to="/inbox/requests"
            title={`${joins.length} ${joins.length === 1 ? "request" : "requests"} to join the company`}
            detail="Review who gets access"
          />
        </Section>
      ) : null}

      {overrideCount > 0 ? (
        <Section label="Administrator override" testId="decisions-override">
          <Row
            testId="decisions-override-row"
            icon={<ShieldAlert className="h-4 w-4 text-destructive" />}
            to="/inbox/override"
            title={`${overrideCount} company ${overrideCount === 1 ? "approval" : "approvals"} open to the override view`}
            detail="Only for exceptional cases; each override needs a reason"
          />
        </Section>
      ) : null}
    </>
  );
}
