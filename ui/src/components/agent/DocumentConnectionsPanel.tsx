import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  documentsApi,
  type DocumentConnectionTier,
  type DocumentConnectionView,
} from "../../api/documents";
import { isCapabilityNotFound } from "../AvailableOnRequest";
import { useCapabilities } from "../../hooks/useCapability";
import {
  browserNavigation,
  documentRedirectUri,
  rememberPendingConnect,
} from "../../lib/document-connect";
import { queryKeys } from "../../lib/queryKeys";
import { timeAgo } from "../../lib/timeAgo";
import { Button } from "../ui/button";

/**
 * AgentDash (per-steward document access, slice 7): the person's own
 * Microsoft 365 connection, on My Agent.
 *
 * An agent reads documents as its current steward, through the server; it
 * never holds the credential. So this is the one place a steward decides
 * whether their agent can see their OneDrive and SharePoint at all, and at
 * which tier: read only, or read plus proposing new files in their own
 * OneDrive (each one still waits for the steward's approval, and nothing is
 * ever overwritten or deleted).
 *
 * The whole panel belongs to a per-company feature flag. While the flag is
 * off the route answers 404 and the panel renders nothing: no notice, no
 * "available on request", because a person cannot act on it. When the flag is
 * on but this instance has no Microsoft sign-in configured, only an instance
 * administrator, who can fix that, is told; a person who already has a stored
 * connection still sees it and can disconnect it, since disconnecting needs no
 * Microsoft configuration and the stored credential would otherwise come back
 * to life, unseen, the moment the configuration does.
 */
export function DocumentConnectionsPanel({
  companyId,
  agentName = "Your agent",
}: {
  companyId: string;
  agentName?: string;
}) {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.myAgent.documents(companyId, "microsoft");

  const health = useQuery({
    queryKey,
    queryFn: () => documentsApi.getMicrosoft(companyId),
    enabled: !!companyId,
    // A 404 here is the flag being off, not a fault worth retrying.
    retry: false,
  });
  const capabilities = useCapabilities(companyId);
  const isInstanceAdmin = capabilities.data?.isInstanceAdmin === true;

  const connect = useMutation({
    mutationFn: async (tier: DocumentConnectionTier) => {
      const redirectUri = documentRedirectUri("microsoft", window.location.origin);
      const { authorizationUrl } = await documentsApi.initiateMicrosoft(companyId, { redirectUri, tier });
      // Remembered for the callback page in this tab: which company the
      // sign-in belongs to and where to come back to. No code, no state.
      rememberPendingConnect({
        provider: "microsoft",
        companyId,
        redirectUri,
        returnTo: window.location.pathname,
      });
      browserNavigation.assign(authorizationUrl);
    },
  });

  const disconnect = useMutation({
    mutationFn: () => documentsApi.revokeMicrosoft(companyId),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  });

  // Once the browser has left for Microsoft the mutation stays "success", so
  // the buttons read "Opening Microsoft…". Pressing Back can restore this page
  // from the back/forward cache with that state intact; start fresh instead.
  const resetConnect = connect.reset;
  useEffect(() => {
    const onPageShow = (event: Event) => {
      if ((event as PageTransitionEvent).persisted) resetConnect();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [resetConnect]);

  if (!companyId || health.isPending) return null;
  if (health.error && isCapabilityNotFound(health.error)) return null;

  if (health.data && !health.data.configured) {
    const stored = health.data.connection;
    if (!stored && !isInstanceAdmin) return null;
    return (
      <PanelFrame>
        {stored ? (
          <>
            {stored.status === "pending" ? (
              <p className="text-sm text-muted-foreground">A Microsoft sign-in was started but not finished.</p>
            ) : (
              <ConnectedDetails view={stored} agentName={agentName} signInUnavailable />
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              Microsoft sign-in is not available on this instance right now, so you cannot reconnect, and{" "}
              {agentName} stops reading your documents once its current Microsoft access expires. You can
              still disconnect, which stops it at once.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
                {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
              </Button>
            </div>
            {disconnect.error ? (
              <p className="mt-2 text-xs text-destructive" role="alert">
                {disconnect.error instanceof Error ? disconnect.error.message : "That did not work. Try again."}
              </p>
            ) : null}
          </>
        ) : null}
        {isInstanceAdmin ? (
          <p className={stored ? "mt-3 text-sm text-muted-foreground" : "text-sm text-muted-foreground"}>
            Document access is on for this workspace but Microsoft sign-in is not configured on this
            instance. Set <code className="font-mono text-xs">ENTRA_TENANT_ID</code>,{" "}
            <code className="font-mono text-xs">ENTRA_CLIENT_ID</code> and{" "}
            <code className="font-mono text-xs">ENTRA_CLIENT_SECRET</code>, then restart. Only instance
            administrators see this.
          </p>
        ) : null}
      </PanelFrame>
    );
  }

  if (health.error) {
    return (
      <PanelFrame>
        <p className="text-xs text-destructive" role="alert">
          {health.error instanceof Error ? health.error.message : "Could not load your Microsoft connection."}
        </p>
      </PanelFrame>
    );
  }

  const view = health.data?.connection ?? null;
  const connected = view !== null && view.status !== "pending";
  const busy = connect.isPending || connect.isSuccess || disconnect.isPending;
  const actionError = connect.error ?? disconnect.error;

  return (
    <PanelFrame>
      {connected ? (
        <ConnectedDetails view={view} agentName={agentName} />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Let {agentName} read your OneDrive and the SharePoint sites you can open, as you. It reads
            through AgentDash and never receives your password or a Microsoft token. You can
            disconnect at any time.
          </p>
          {view?.status === "pending" ? (
            <p className="mt-1.5 text-xs text-muted-foreground">
              A Microsoft sign-in was started but not finished. Connect again to finish it.
            </p>
          ) : null}
          {view?.lastError ? <LastError error={view.lastError} /> : null}
        </>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {!connected ? (
          <Button size="sm" disabled={busy} onClick={() => connect.mutate("read")}>
            {connect.isPending || connect.isSuccess ? "Opening Microsoft…" : "Connect Microsoft 365"}
          </Button>
        ) : (
          <>
            {view.status !== "active" ? (
              <Button size="sm" disabled={busy} onClick={() => connect.mutate(view.tier ?? "read")}>
                Reconnect
              </Button>
            ) : null}
            {view.tier !== "read_propose" ? (
              <Button
                size="sm"
                variant={view.status === "active" ? "default" : "outline"}
                disabled={busy}
                onClick={() => connect.mutate("read_propose")}
              >
                Reconnect with write access
              </Button>
            ) : null}
            <Button size="sm" variant="outline" disabled={busy} onClick={() => disconnect.mutate()}>
              {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
            </Button>
          </>
        )}
      </div>

      {connected && view.tier !== "read_propose" ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Write access lets {agentName} propose new files in your own OneDrive. Each one waits for
          your approval, and it never changes or deletes a file that is already there. Microsoft
          asks you to sign in again, and Microsoft will ask for permission to edit your files.
          AgentDash itself only ever creates new files, after your approval.
        </p>
      ) : null}

      {actionError ? (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {actionError instanceof Error ? actionError.message : "That did not work. Try again."}
        </p>
      ) : null}
    </PanelFrame>
  );
}

function PanelFrame({ children }: { children: React.ReactNode }) {
  return (
    <section aria-labelledby="my-agent-documents-heading" className="rounded-lg border border-border bg-card">
      <div className="border-b px-4 py-2.5">
        <h2 id="my-agent-documents-heading" className="text-sm font-semibold">
          Microsoft 365 documents
        </h2>
      </div>
      <div className="px-4 py-4">{children}</div>
    </section>
  );
}

const TIER_LABEL: Record<DocumentConnectionTier, string> = {
  read: "Read only",
  read_propose: "Read, and propose new files",
};

function statusLabel(status: DocumentConnectionView["status"]): string {
  if (status === "active") return "Connected";
  if (status === "pending") return "Not finished";
  return "Needs reconnecting";
}

function ConnectedDetails({
  view,
  agentName,
  signInUnavailable = false,
}: {
  view: DocumentConnectionView;
  agentName: string;
  /** The instance has no Microsoft sign-in configured, so the connection cannot be refreshed. */
  signInUnavailable?: boolean;
}) {
  const healthy = view.status === "active";
  return (
    <>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Account</dt>
        <dd className="min-w-0 break-words font-medium">{view.account ?? "Unknown account"}</dd>
        <dt className="text-muted-foreground">Access</dt>
        <dd>{view.tier ? TIER_LABEL[view.tier] : "Unknown"}</dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd className={healthy ? undefined : "text-destructive"}>{statusLabel(view.status)}</dd>
      </dl>
      {signInUnavailable ? null : (
        <p className="mt-2 text-xs text-muted-foreground">
          {healthy
            ? `${agentName} reads what this account can open, while you are its steward.`
            : `${agentName} cannot read your documents until you reconnect.`}
        </p>
      )}
      {view.lastError ? <LastError error={view.lastError} /> : null}
    </>
  );
}

function LastError({ error }: { error: NonNullable<DocumentConnectionView["lastError"]> }) {
  return (
    <p className="mt-2 text-xs text-destructive" role="alert">
      {error.message}
      {error.at ? <span className="text-muted-foreground"> · {timeAgo(error.at)}</span> : null}
    </p>
  );
}
