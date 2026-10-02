// AgentDash (scan 3, lane G): a task created from a confirmed CoS suggestion.
// The card links straight to the new issue so the founder can follow it.
import { Link } from "@/lib/router";
import { issueUrl } from "../../lib/utils";

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
  const label = payload.identifier ? `${payload.identifier} · ${payload.title}` : payload.title;
  const nextStep = issueCreatedNextStep(payload.assigneeName, payload.status);
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
