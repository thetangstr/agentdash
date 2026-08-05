import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { ApiError } from "@/api/client";
import {
  connectorSendExecutionsApi,
  type ConnectorSendExecutionRow,
  type ReconcileVerdict,
} from "@/api/connector-send-executions";

interface Props {
  companyId: string;
}

/**
 * AgentDash-MK T4: the "Needs reconciliation" list (audit item 14).
 *
 * Lives beside the agent-ceiling editor in Company Settings — the existing home
 * for MK governance, whose audience (owner/admin and the requesting steward) is
 * exactly who may reconcile. The alternative home, the Inbox attention area,
 * mixes per-issue triage with company-wide governance; keeping reconciliation
 * next to the ceilings it belongs to reads more honestly and keeps this slice's
 * footprint off a 2,600-line file.
 *
 * Authority is resolved server-side: the list route 404s off `agentdash_mk` and
 * 403s a member who is neither owner/admin nor the requesting steward. A 403 is
 * shown as a refusal, never an empty list, so the surface never implies
 * "nothing to reconcile" to someone who simply cannot see it. Reconcile records
 * a human's verdict as an audit fact and does NOT resend — resending stays with
 * the approvals flow, the only decision boundary.
 */
export function NeedsReconciliationPanel({ companyId }: Props) {
  const queryClient = useQueryClient();
  const listKey = ["connectorSendExecutions", companyId, "unresolved"] as const;

  const list = useQuery({
    queryKey: listKey,
    queryFn: () => connectorSendExecutionsApi.listUnresolved(companyId),
    enabled: !!companyId,
    retry: false,
  });

  // Presentation only: names for the requesting agents. The list route already
  // scopes rows to what the viewer may see, so this never widens visibility.
  const agentsQuery = useQuery({
    queryKey: ["agents", companyId, "for-reconciliation"],
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });
  const agentNameById = new Map<string, string>(
    (agentsQuery.data ?? []).map((agent: Agent) => [agent.id, agent.name]),
  );

  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reconcile = useMutation({
    mutationFn: (input: { row: ConnectorSendExecutionRow; verdict: ReconcileVerdict }) =>
      connectorSendExecutionsApi.reconcile(companyId, input.row.id, {
        verdict: input.verdict,
        revision: input.row.revision,
      }),
    onMutate: (input) => {
      setPendingId(input.row.id);
      setError(null);
    },
    onSuccess: () => {
      // The server excludes reconciled rows, so a refetch removes this one.
      queryClient.invalidateQueries({ queryKey: listKey });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed to record the verdict");
    },
    onSettled: () => {
      setPendingId(null);
    },
  });

  const forbidden = list.error instanceof ApiError && list.error.status === 403;

  return (
    <section aria-labelledby="reconcile-heading" className="space-y-3 rounded-lg border p-4">
      <div>
        <h2 id="reconcile-heading" className="text-base font-semibold">
          Needs reconciliation
        </h2>
        <p className="text-xs text-muted-foreground">
          Connector writes whose delivery could not be confirmed. Confirming one records an audit
          verdict — it does not resend. Resending stays with the approvals flow.
        </p>
      </div>

      {forbidden ? (
        <p role="alert" className="text-sm text-muted-foreground">
          You do not have access to reconcile connector sends. Ask a company owner, an
          administrator, or the requesting agent's steward.
        </p>
      ) : list.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : list.error ? (
        <p role="alert" className="text-sm text-destructive">
          {list.error instanceof Error ? list.error.message : "Failed to load the list"}
        </p>
      ) : (list.data?.items.length ?? 0) === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing needs reconciliation.</p>
      ) : (
        <ul className="space-y-2">
          {list.data!.items.map((item) => {
            const agentName = item.requestedByAgentId
              ? agentNameById.get(item.requestedByAgentId) ?? item.requestedByAgentId
              : "an agent (no longer present)";
            const busy = pendingId === item.id && reconcile.isPending;
            return (
              <li key={item.id} className="space-y-1 rounded border p-3 text-xs">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{agentName}</span>
                  <span className="text-muted-foreground">
                    {new Date(item.executedAt).toLocaleString()}
                  </span>
                </div>
                <p>
                  <span className="font-mono">
                    {item.operation} {item.objectType}
                  </span>{" "}
                  on <span className="font-mono">{item.provider}</span>
                </p>
                {item.reason ? <p className="text-muted-foreground">{item.reason}</p> : null}
                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      reconcile.mutate({ row: item, verdict: "confirmed_delivered" })
                    }
                    className="rounded border px-2 py-1 disabled:opacity-50"
                  >
                    Confirm delivered
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => reconcile.mutate({ row: item, verdict: "confirmed_failed" })}
                    className="rounded border px-2 py-1 disabled:opacity-50"
                  >
                    Confirm failed
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
