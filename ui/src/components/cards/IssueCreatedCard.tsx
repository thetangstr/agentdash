// AgentDash (scan 3, lane G): a task created from a confirmed CoS suggestion.
// The card links straight to the new issue so the founder can follow it.
import { Link } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { issueUrl } from "../../lib/utils";
import { activityApi } from "../../api/activity";
import { heartbeatsApi } from "../../api/heartbeats";
import { issuesApi } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
import { isIssueWorkStopped, latestRunByCreatedAt } from "../../lib/issue-stopped";

export interface IssueCreatedCardPayload {
  issueId: string;
  identifier?: string | null;
  title: string;
  assigneeName?: string | null;
  /** The issue's status at creation; the company's default for new issues. */
  status?: string | null;
}

/** What happens next, in the words of the issue's starting status. */
export function issueCreatedNextStep(assigneeName: string | null | undefined, status: string | null | undefined): string | null {
  if (!assigneeName) return null;
  if (status === "backlog") return `Added to ${assigneeName}'s backlog.`;
  return `Assigned to ${assigneeName}. They'll start on it now.`;
}

export function IssueCreatedCard({ payload }: { payload: IssueCreatedCardPayload | null | undefined }) {
  if (!payload || typeof payload.issueId !== "string" || typeof payload.title !== "string") return null;
  return <IssueCreatedCardBody payload={payload} />;
}

function IssueCreatedCardBody({ payload }: { payload: IssueCreatedCardPayload }) {
  // AgentDash (c4-stops): the card outlives the run that created the task —
  // when its newest run was stopped and nothing is live, the "they'll start
  // on it now" line is a lie; say so and point at the issue's Resume.
  const { data: issue } = useQuery({
    queryKey: queryKeys.issues.detail(payload.issueId),
    queryFn: () => issuesApi.get(payload.issueId),
    staleTime: 30_000,
  });
  const issueTrackable = issue?.status === "in_progress" || issue?.status === "todo";
  const { data: issueRuns } = useQuery({
    queryKey: queryKeys.issues.runs(payload.issueId),
    queryFn: () => activityApi.runsForIssue(payload.issueId),
    enabled: issueTrackable,
    staleTime: 30_000,
  });
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.issues.liveRuns(payload.issueId),
    queryFn: () => heartbeatsApi.liveRunsForIssue(payload.issueId),
    enabled: issueTrackable,
    staleTime: 30_000,
  });
  const stopped = isIssueWorkStopped({
    status: issue?.status,
    hasLiveRun: (liveRuns?.length ?? 0) > 0,
    latestRunStatus: latestRunByCreatedAt(issueRuns ?? [])?.status,
  });

  const label = payload.identifier ? `${payload.identifier} · ${payload.title}` : payload.title;
  const nextStep = stopped
    ? "Work on this was stopped — open the issue to resume it."
    : issueCreatedNextStep(payload.assigneeName, issue?.status ?? payload.status);
  return (
    <div
      className="w-full min-w-0 break-words rounded-lg border border-border-soft bg-surface-raised p-3 text-sm shadow-sm sm:p-4"
      data-testid="issue-created-card"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-text-tertiary">Task created</p>
      <Link
        to={issueUrl({ id: payload.issueId, identifier: payload.identifier })}
        className="mt-1 inline-flex min-h-11 items-center font-medium text-text-primary underline sm:min-h-0"
      >
        {label}
      </Link>
      {nextStep ? <p className="mt-1 text-text-secondary">{nextStep}</p> : null}
    </div>
  );
}
