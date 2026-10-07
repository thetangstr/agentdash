// AgentDash (GH #886): an agent's instructions, skills and configuration
// history are readable by whoever may change them — the agent's steward, or a
// company owner or admin. Everyone else gets a 403 from those routes; the
// agent page shows this plain explanation instead of an empty editor.
import { ApiError } from "@/api/client";

export function isAgentConfigForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export function AgentConfigAccessNotice({
  what,
  className,
}: {
  /** Plain-language name of what is hidden, e.g. "instructions". */
  what: string;
  className?: string;
}) {
  return (
    <div className={className ?? "max-w-3xl"} data-testid="agent-config-access-notice">
      <p className="text-sm text-muted-foreground">
        Only this agent's steward or a company owner or admin can see its {what}. Ask one of them
        if you need to look at or change it.
      </p>
    </div>
  );
}
