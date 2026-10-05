import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isIssueWorkStopped } from "../lib/issue-stopped";

// AgentDash (c4-stops): after a Stop the issue still reads "in progress" but
// nothing is running — a wedge a nontechnical owner can't read. This banner
// names what happened (and who stopped it when it was this viewer) and offers
// the explicit resume: a wake for the assigned agent, never an implicit one
// from an unrelated comment.

export function IssueStoppedBanner({
  issue,
  hasLiveRuns,
  latestRunStatus,
  stoppedByYou,
  agentName,
  isResuming,
  onResume,
}: {
  issue: { status: string; assigneeAgentId: string | null | undefined };
  hasLiveRuns: boolean;
  latestRunStatus: string | null | undefined;
  /** True when this browser session requested the stop — "Stopped by you." */
  stoppedByYou: boolean;
  agentName: string | null;
  isResuming: boolean;
  onResume: () => void;
}) {
  if (!isIssueWorkStopped({ status: issue.status, hasLiveRun: hasLiveRuns, latestRunStatus })) return null;
  const who = agentName?.trim() || "the assigned agent";
  const canResume = !!issue.assigneeAgentId;
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2.5 text-sm"
      data-testid="issue-stopped-banner"
    >
      <p className="text-muted-foreground">
        <span className="font-medium text-foreground">
          {stoppedByYou ? "Stopped by you." : "Stopped."}
        </span>{" "}
        {canResume
          ? `Nothing is running on this issue — resume asks ${who} to pick it back up.`
          : "Nothing is running on this issue — assign it to an agent to resume the work."}
      </p>
      {canResume ? (
        <Button size="sm" onClick={onResume} disabled={isResuming}>
          <Play className="mr-1.5 h-3.5 w-3.5" />
          {isResuming ? "Resuming…" : "Resume"}
        </Button>
      ) : null}
    </div>
  );
}
