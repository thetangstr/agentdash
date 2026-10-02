// AgentDash (GH #793, UX-12): Settings > Connections — the one place a person
// can see what reaches into this workspace from outside: the GitHub repo
// connection (rotate or remove the token) and assistant OAuth grants
// (connect Muse or Grok, revoke a grant). The GitHub token is write-only on
// the server; this page can replace it but can never display it.
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Github, Link2, Smartphone } from "lucide-react";
import { githubConnectionsApi } from "@/api/githubConnections";
import { AssistantConnections } from "@/components/agent/AssistantConnections";
import { GitHubConnectStep } from "@/components/onboarding/GitHubConnectStep";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { Link, useLocation } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";

export function CompanyConnections() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  // AgentDash (Lane F2): the Slack OAuth callback returns here with
  // `?slack=connected&team=...` or `?slack=error`; say what happened.
  const location = useLocation();
  const slackParams = new URLSearchParams(location.search);
  const slackResult = slackParams.get("slack");
  const slackTeam = slackParams.get("team");

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Settings", href: "/company/settings" },
      { label: "Connections" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const connections = useQuery({
    queryKey: queryKeys.githubConnections.list(selectedCompanyId ?? ""),
    queryFn: () => githubConnectionsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    retry: false,
  });

  const disconnect = useMutation({
    mutationFn: (connectionId: string) =>
      githubConnectionsApi.disconnect(selectedCompanyId!, connectionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.githubConnections.list(selectedCompanyId!),
      });
    },
  });

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">Select a company to manage connections.</div>;
  }

  const items = connections.data?.connections ?? [];
  const canManage = connections.data?.canManage ?? false;

  return (
    <div className="max-w-3xl space-y-8" data-testid="company-connections">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Link2 className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Connections</h1>
        </div>
        {slackResult === "connected" ? (
          <p role="status" className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
            Slack connected{slackTeam ? ` to ${slackTeam}` : ""}.
          </p>
        ) : slackResult === "error" ? (
          <p role="alert" className="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">
            Slack could not be connected. Try again from your agent's Slack setup.
          </p>
        ) : null}
        <p className="max-w-3xl text-sm text-muted-foreground">
          What reaches into this workspace from outside — the repository your agents work in and the
          assistants you approved.
        </p>
      </div>

      <section className="rounded-lg border border-border bg-card" aria-labelledby="github-card-heading">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <Github className="h-4 w-4 text-muted-foreground" />
          <h2 id="github-card-heading" className="text-sm font-semibold">
            GitHub
          </h2>
        </div>
        <div className="px-4 py-3">
          {connections.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading GitHub connection…</p>
          ) : connections.error ? (
            <p role="alert" className="text-sm text-destructive">
              {connections.error instanceof Error
                ? connections.error.message
                : "Could not load the GitHub connection."}
            </p>
          ) : items.length === 0 ? (
            <GitHubConnectStep
              variant="section"
              companyId={selectedCompanyId}
              connection={null}
              canManage={canManage}
              onConnected={() => {
                void queryClient.invalidateQueries({
                  queryKey: queryKeys.githubConnections.list(selectedCompanyId),
                });
                void queryClient.invalidateQueries({ queryKey: ["projects"] });
              }}
            />
          ) : (
            <ul className="divide-y divide-border">
              {items.map((connection) => (
                <li key={connection.id} className="py-3 first:pt-0 last:pb-0">
                  <GitHubConnectStep
                    key={`${connection.id}:${connection.repo}`}
                    variant="section"
                    companyId={selectedCompanyId}
                    projectId={connection.projectId}
                    connection={connection}
                    canManage={canManage}
                    onConnected={() => {
                      void queryClient.invalidateQueries({
                        queryKey: queryKeys.githubConnections.list(selectedCompanyId),
                      });
                      void queryClient.invalidateQueries({ queryKey: ["projects"] });
                    }}
                  />
                  <div className="mt-2 flex items-center gap-3">
                    {connection.projectName ? (
                      <span className="text-xs text-muted-foreground">
                        Project {connection.projectName}
                      </span>
                    ) : null}
                    {canManage ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={disconnect.isPending}
                        onClick={() => disconnect.mutate(connection.id)}
                      >
                        {disconnect.isPending ? "Removing…" : "Remove connection"}
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {disconnect.error ? (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {disconnect.error instanceof Error
                ? disconnect.error.message
                : "Could not remove the connection."}
            </p>
          ) : null}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card" aria-labelledby="assistant-card-heading">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <Smartphone className="h-4 w-4 text-muted-foreground" />
          <h2 id="assistant-card-heading" className="text-sm font-semibold">
            Assistant
          </h2>
        </div>
        <div className="space-y-3 px-4 py-3">
          <p className="text-sm text-muted-foreground">
            Connect an assistant like Muse or Grok to ask your agents for work and hear what shipped
            from your phone.
          </p>
          <div>
            <Button asChild size="sm" variant="outline">
              <Link to="/connect-assistant">Connect your assistant</Link>
            </Button>
          </div>
          <AssistantConnections companyId={selectedCompanyId} />
        </div>
      </section>
    </div>
  );
}
