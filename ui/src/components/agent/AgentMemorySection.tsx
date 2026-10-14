import { useQuery } from "@tanstack/react-query";
import { agentMemoryApi } from "../../api/agent-memory";
import { queryKeys } from "../../lib/queryKeys";
import { formatDateTime } from "../../lib/utils";

/**
 * Read-only view of an agent's memory: the lessons it kept from its person's
 * corrections, for the steward those lessons came from.
 *
 * The server is the gate — it answers only the agent, its steward and admins,
 * and 404 to everyone else — so this renders nothing unless the read succeeds.
 * Editing stays with the agent (and the memory API for its steward/admins).
 */
export function AgentMemorySection({ companyId, agentId }: { companyId: string; agentId: string }) {
  const { data } = useQuery({
    queryKey: queryKeys.agents.memory(companyId, agentId),
    queryFn: () => agentMemoryApi.history(companyId, agentId),
    retry: false,
  });
  if (!data) return null;

  return (
    <div className="space-y-3" data-testid="agent-memory-section">
      <h3 className="text-sm font-medium">Memory</h3>
      <p className="text-xs text-muted-foreground">
        What this agent has learned from corrections, only visible to the agent, its steward and admins.
      </p>
      {data.history.length === 0 ? (
        <p className="text-xs text-muted-foreground">No memory yet.</p>
      ) : (
        <ol className="space-y-2">
          {data.history.map((entry) => (
            <li key={entry.id} className="rounded-md border p-3" data-testid="agent-memory-version">
              <div className="mb-1 text-xs text-muted-foreground">
                v{entry.version} · {formatDateTime(entry.writtenAt)}
                {entry.authorKind === "agent" ? "" : ` · edited by its ${entry.authorKind}`}
                {entry.supersededAt ? " · replaced" : " · current"}
              </div>
              <pre className="whitespace-pre-wrap break-words font-sans text-xs">{entry.content}</pre>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
