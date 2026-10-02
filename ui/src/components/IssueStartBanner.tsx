import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";

// AgentDash (scan 2, E2): the onboarding wizard tells the owner that nothing
// runs until they say so, and creates its tasks parked in `backlog` to keep
// that true. This is where they say so. Start moves the issue to `todo`, and
// the server wakes the assigned agent on that transition — the same thing
// changing the status by hand does, made obvious for someone who has never
// seen the status menu.
//
// Shown for any parked issue with an assigned agent, not only the wizard's:
// "assigned but parked" means the same thing everywhere, and one UX for every
// company means no special case for where the issue came from.

export function shouldOfferIssueStart(issue: { status: string; assigneeAgentId: string | null | undefined }): boolean {
  return issue.status === "backlog" && Boolean(issue.assigneeAgentId);
}

export function IssueStartBanner({
  issue,
  agentName,
  isStarting,
  onStart,
}: {
  issue: { status: string; assigneeAgentId: string | null | undefined };
  agentName: string | null;
  isStarting: boolean;
  onStart: () => void;
}) {
  if (!shouldOfferIssueStart(issue)) return null;
  const who = agentName?.trim() || "The assigned agent";
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2.5 text-sm"
      data-testid="issue-start-banner"
    >
      <p className="text-muted-foreground">
        <span className="font-medium text-foreground">Not started.</span> {who} will not work on this
        until you press Start.
      </p>
      <Button size="sm" onClick={onStart} disabled={isStarting}>
        <Play className="mr-1.5 h-3.5 w-3.5" />
        {isStarting ? "Starting…" : "Start"}
      </Button>
    </div>
  );
}
