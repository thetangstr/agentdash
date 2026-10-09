// AgentDash: an issue an agent the person answers for has blocked — it stopped
// and needs them. Listed on Home's "Waiting on you" and the Decisions page; the
// bridge digest's "Stopped and needs you" reads the same server definition.
import type { WaitingOnYouStoppedAgentIssue } from "@paperclipai/shared";
import { OctagonPause } from "lucide-react";
import { Link } from "@/lib/router";
import { issueUrl } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";

export function StoppedAgentIssueRow({
  item,
  testId = "stopped-agent-issue-row",
}: {
  item: WaitingOnYouStoppedAgentIssue;
  testId?: string;
}) {
  return (
    <li data-testid={testId} className="flex items-start gap-3 px-4 py-2.5">
      <OctagonPause className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      <div className="min-w-0 flex-1">
        <Link to={issueUrl({ id: item.issueId, identifier: item.identifier })} className="text-sm font-medium hover:underline">
          {item.identifier ? <span className="text-muted-foreground">{item.identifier} </span> : null}
          {item.title}
        </Link>
        <div className="flex min-w-0 flex-wrap gap-x-2 text-xs [overflow-wrap:anywhere] text-muted-foreground">
          <span>{item.agentName ? `${item.agentName} stopped and needs you` : "Your agent stopped and needs you"}</span>
          <span aria-hidden>·</span>
          <span>waiting {timeAgo(item.waitingSince)}</span>
        </div>
      </div>
    </li>
  );
}
