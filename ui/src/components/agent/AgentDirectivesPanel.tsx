import { useQuery } from "@tanstack/react-query";
import { agentDirectivesApi } from "../../api/agent-directives";
import { queryKeys } from "../../lib/queryKeys";
import { formatDateTime } from "../../lib/utils";

/**
 * AgentDash admin powers (part 4): a read-only view of an agent's directives.
 *
 * The server is the gate: it answers the agent's steward, and an owner or
 * admin when the company allows admins to read directives (and records each
 * such read). Everyone else gets 403 or 404, so this renders nothing unless
 * the read succeeds; there is no product-profile branch here. Writing stays
 * with the steward.
 */
export function AgentDirectivesPanel({ companyId, agentId }: { companyId: string; agentId: string }) {
  const { data } = useQuery({
    queryKey: queryKeys.agentDirectives(companyId, agentId),
    queryFn: () => agentDirectivesApi.history(companyId, agentId),
    retry: false,
    // An admin's read is recorded each time; do not refetch behind their back.
    refetchOnWindowFocus: false,
    staleTime: 5 * 60_000,
  });
  if (!data) return null;

  return (
    <div className="space-y-3" data-testid="agent-directives-panel">
      <h3 className="text-sm font-medium">Directives</h3>
      <p className="text-xs text-muted-foreground">
        What this agent's steward has told it. Read-only here.
      </p>
      {data.active ? (
        <div className="rounded-md border p-3" data-testid="agent-directives-active">
          <div className="mb-1 text-xs text-muted-foreground">
            v{data.active.version} · {formatDateTime(data.active.pushedAt)} · current
          </div>
          <pre className="whitespace-pre-wrap break-words font-sans text-xs">{data.active.directives}</pre>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="agent-directives-none">No directives yet.</p>
      )}
      {data.history.filter((entry) => entry.supersededAt).length > 0 ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Earlier versions</summary>
          <ol className="mt-2 space-y-2">
            {data.history.filter((entry) => entry.supersededAt).map((entry) => (
              <li key={entry.id} className="rounded-md border p-3" data-testid="agent-directives-version">
                <div className="mb-1 text-muted-foreground">v{entry.version} · {formatDateTime(entry.pushedAt)} · replaced</div>
                <pre className="whitespace-pre-wrap break-words font-sans">{entry.directives}</pre>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
}
