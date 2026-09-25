import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { assistantGrantsApi } from "../../api/assistant-grants";
import { timeAgo } from "../../lib/timeAgo";
import { Button } from "../ui/button";

/**
 * AgentDash assistant MCP (GH #677): the Connections card for OAuth grants.
 *
 * Sits beside "Connected machines" because it is the same shape of promise:
 * something outside AgentDash holding a credential that reaches this person's
 * workspace, listed with the same "take it back" affordance. A revoked grant
 * kills its tokens on the spot — the row disappears and so does the access.
 */

const SCOPE_SHORT: Record<string, string> = {
  "agentdash:read": "read",
  "agentdash:work": "work",
  "agentdash:decide": "decide",
};

export function AssistantConnections({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const grants = useQuery({
    queryKey: ["assistant", "me", "grants", companyId],
    queryFn: () => assistantGrantsApi.listMine(companyId),
  });
  const revoke = useMutation({
    mutationFn: (grantId: string) => assistantGrantsApi.revoke(companyId, grantId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["assistant", "me", "grants", companyId] });
    },
  });

  const items = grants.data?.grants ?? [];
  if (items.length === 0 && !grants.isLoading) return null;

  return (
    <section
      aria-labelledby="assistant-connections-heading"
      className="rounded-lg border border-border bg-card"
    >
      <div className="flex items-center justify-between gap-3 border-b px-4 py-2.5">
        <h2 id="assistant-connections-heading" className="text-sm font-semibold">
          Connected assistants
        </h2>
        <span className="font-mono text-xs text-muted-foreground">{items.length}</span>
      </div>
      <ul className="divide-y divide-border">
        {items.map((grant) => (
          <li
            key={grant.id}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2.5"
          >
            <span className="text-sm">
              {grant.clientName}
              <span className="ml-2 font-mono text-xs text-muted-foreground">
                {grant.redirectHost}
                {" · "}
                {grant.scopes.map((scope) => SCOPE_SHORT[scope] ?? scope).join(", ")}
                {grant.lastUsedAt ? ` · used ${timeAgo(grant.lastUsedAt)}` : " · never used"}
              </span>
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(grant.id)}
            >
              {revoke.isPending ? "Disconnecting…" : "Disconnect"}
            </Button>
          </li>
        ))}
      </ul>
      <p className="px-4 py-2.5 text-xs text-muted-foreground">
        Disconnecting revokes the assistant's access immediately — its tokens stop working at once.
        Reconnect from the assistant whenever you want it back.
      </p>
      {revoke.error ? (
        <p className="px-4 pb-2.5 text-xs text-destructive" role="alert">
          {revoke.error instanceof Error ? revoke.error.message : "Could not disconnect."}
        </p>
      ) : null}
    </section>
  );
}
