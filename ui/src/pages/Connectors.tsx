// AgentDash: One-Click Connectors page for managing provider integrations
import { useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { connectorsApi, type Connector } from "../api/connectors";
import { CONNECTOR_PROVIDERS, CONNECTOR_PROVIDER_LABELS } from "@agentdash/shared";
import { Button } from "@/components/ui/button";
import { EmptyState } from "../components/EmptyState";
import { relativeTime, cn } from "../lib/utils";
import {
  Plug,
  Unplug,
  AlertCircle,
  CheckCircle2,
  Circle,
} from "lucide-react";

const PROVIDER_DESCRIPTIONS: Record<string, string> = {
  microsoft365: "Outlook email, OneDrive files, Calendar, Teams",
  hubspot: "CRM contacts, deals, companies, pipeline",
  google: "Gmail, Google Drive, Calendar",
  slack: "Channels, direct messages, notifications",
};

// AgentDash: Connectors page — connect/disconnect external provider integrations
export function Connectors() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Connectors" }]);
  }, [setBreadcrumbs]);

  const { data: connectors, isLoading } = useQuery({
    queryKey: queryKeys.connectors.list(selectedCompanyId!),
    queryFn: () => connectorsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const connectMutation = useMutation({
    mutationFn: (provider: string) =>
      connectorsApi.connect(selectedCompanyId!, provider),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.connectors.list(selectedCompanyId!),
      });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: (connectorId: string) =>
      connectorsApi.disconnect(selectedCompanyId!, connectorId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.connectors.list(selectedCompanyId!),
      });
    },
  });

  if (!selectedCompanyId) {
    return (
      <p className="text-sm text-muted-foreground p-6">
        Select a company first.
      </p>
    );
  }

  const connectedMap = new Map<string, Connector>();
  if (connectors) {
    for (const c of connectors) {
      if (c.status !== "disconnected") {
        connectedMap.set(c.provider, c);
      }
    }
  }

  const connectedList = Array.from(connectedMap.values());
  const availableProviders = CONNECTOR_PROVIDERS.filter(
    (p) => !connectedMap.has(p),
  );

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b">
        <Plug className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Connectors</h1>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-8">
        {/* Connected section */}
        {!isLoading && connectedList.length > 0 && (
          <section>
            <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
              Connected
            </h2>
            <div className="space-y-2">
              {connectedList.map((connector) => (
                <div
                  key={connector.id}
                  className="flex items-center gap-4 rounded-lg border bg-card px-4 py-3"
                >
                  <ConnectorStatusIcon status={connector.status} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        {CONNECTOR_PROVIDER_LABELS[connector.provider as keyof typeof CONNECTOR_PROVIDER_LABELS] ??
                          connector.provider}
                      </span>
                      {connector.status === "error" && (
                        <span className="text-xs text-destructive">
                          {connector.errorMessage ?? "Error"}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {PROVIDER_DESCRIPTIONS[connector.provider] ?? connector.displayName}
                    </p>
                    {connector.connectedAt && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Connected {relativeTime(connector.connectedAt)}
                      </p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className={cn(
                      "shrink-0",
                      disconnectMutation.isPending && "opacity-50",
                    )}
                    onClick={() => disconnectMutation.mutate(connector.id)}
                    disabled={disconnectMutation.isPending}
                  >
                    <Unplug className="h-3.5 w-3.5 mr-1.5" />
                    Disconnect
                  </Button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Available section */}
        <section>
          <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
            Available
          </h2>
          {isLoading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-24 rounded-lg border bg-muted/30 animate-pulse"
                />
              ))}
            </div>
          ) : availableProviders.length === 0 ? (
            <EmptyState
              icon={Plug}
              message="All available providers are connected"
            />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {availableProviders.map((provider) => (
                <div
                  key={provider}
                  className="flex items-center gap-4 rounded-lg border bg-card px-4 py-3"
                >
                  <Circle className="h-5 w-5 text-muted-foreground/40 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">
                      {CONNECTOR_PROVIDER_LABELS[provider as keyof typeof CONNECTOR_PROVIDER_LABELS] ?? provider}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {PROVIDER_DESCRIPTIONS[provider] ?? ""}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    className="shrink-0"
                    onClick={() => connectMutation.mutate(provider)}
                    disabled={
                      connectMutation.isPending &&
                      connectMutation.variables === provider
                    }
                  >
                    <Plug className="h-3.5 w-3.5 mr-1.5" />
                    Connect
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function ConnectorStatusIcon({ status }: { status: Connector["status"] }) {
  if (status === "connected") {
    return <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" />;
  }
  if (status === "error") {
    return <AlertCircle className="h-5 w-5 text-destructive shrink-0" />;
  }
  return <Circle className="h-5 w-5 text-muted-foreground shrink-0" />;
}
