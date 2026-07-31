import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { hubspotApi } from "../../api/hubspot";
import { queryKeys } from "../../lib/queryKeys";

/**
 * AgentDash-MK: the signed-in steward's own HubSpot key.
 *
 * The panel exists as much to state a limitation as to collect a token. A
 * HubSpot private-app token is portal-scoped and created by a super admin, so
 * a write made with one member's key is indistinguishable in HubSpot from any
 * other member's. The product owner accepted that on 2026-07-30 — accepting it
 * is not the same as hiding it, and a person pasting a key deserves to know
 * what their name will and will not be attached to.
 */
export function HubspotConnectionPanel({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");

  const connection = useQuery({
    queryKey: queryKeys.myAgent.hubspot(companyId),
    queryFn: () => hubspotApi.get(companyId),
    enabled: !!companyId,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.myAgent.hubspot(companyId) });
  };

  const connect = useMutation({
    mutationFn: () => hubspotApi.connect(companyId, token),
    onSuccess: () => setToken(""),
    onSettled: invalidate,
  });
  const recheck = useMutation({
    mutationFn: () => hubspotApi.recheck(companyId),
    onSettled: invalidate,
  });
  const revoke = useMutation({
    mutationFn: () => hubspotApi.revoke(companyId),
    onSettled: invalidate,
  });

  const active = connection.data?.connection ?? null;
  const recheckResult = recheck.data;

  return (
    <section aria-labelledby="my-agent-hubspot-heading" className="rounded-lg border p-4">
      <h2 id="my-agent-hubspot-heading" className="text-sm font-semibold">
        HubSpot
      </h2>

      {active ? (
        <div className="mt-2 flex flex-col gap-2 text-xs">
          <p>
            Connected to portal <span className="font-medium">{active.hubId ?? "unknown"}</span> ·{" "}
            <span className="font-medium">{active.status}</span> · {active.scopes.length} scopes
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded border px-2 py-1 text-xs"
              disabled={recheck.isPending}
              onClick={() => recheck.mutate()}
            >
              {recheck.isPending ? "Checking…" : "Check key"}
            </button>
            <button
              type="button"
              className="rounded border px-2 py-1 text-xs"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate()}
            >
              {revoke.isPending ? "Disconnecting…" : "Disconnect"}
            </button>
          </div>
          {/* Scope drift is silent in HubSpot: a super admin can narrow a
              private app at any time and nothing tells us. Surfacing it here is
              the only warning before an agent run fails. */}
          {recheckResult?.healthy && recheckResult.scopesLost.length > 0 && (
            <p className="text-destructive" role="alert">
              This key lost {recheckResult.scopesLost.length} scope
              {recheckResult.scopesLost.length === 1 ? "" : "s"} since you connected it:{" "}
              {recheckResult.scopesLost.join(", ")}
            </p>
          )}
          {recheckResult && !recheckResult.healthy && (
            <p className="text-destructive" role="alert">
              {recheckResult.reason}
            </p>
          )}
        </div>
      ) : (
        <div className="mt-2 flex flex-col gap-2 text-xs">
          <p className="text-muted-foreground">
            Paste a HubSpot private app token so your agent can read your CRM. It is validated
            against a live read before it is stored, and it is only ever usable by your agent.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="password"
              aria-label="HubSpot private app token"
              className="rounded border px-2 py-1 text-xs"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="pat-…"
            />
            <button
              type="button"
              className="rounded border px-2 py-1 text-xs"
              disabled={connect.isPending || token.trim().length === 0}
              onClick={() => connect.mutate()}
            >
              {connect.isPending ? "Validating…" : "Connect HubSpot"}
            </button>
          </div>
        </div>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        <span className="font-medium">Writes are attributed to the app, not to you.</span> HubSpot
        private app tokens are portal-scoped, so a change your agent makes is recorded in HubSpot as
        coming from the connected app rather than from your user. AgentDash records who requested
        and who approved every write; HubSpot does not.
      </p>

      <p className="mt-1 text-xs text-muted-foreground">
        Your agent cannot write on its own. It files a request, you approve it here, and the change
        happens then.
      </p>

      {connect.error && (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {connect.error instanceof Error ? connect.error.message : "Could not connect HubSpot"}
        </p>
      )}
      {revoke.error && (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {revoke.error instanceof Error ? revoke.error.message : "Could not disconnect"}
        </p>
      )}
    </section>
  );
}
