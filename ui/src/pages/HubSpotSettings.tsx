// AgentDash: HubSpotSettings page — CUJ-A integration config
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  XCircle,
  Plug,
  RefreshCw,
  Link2,
  Link2Off,
  Loader2,
} from "lucide-react";
import {
  crmApi,
  type HubspotConfig,
  type HubspotFieldMapping,
  type HubspotSyncDirection,
} from "../api/crm";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

// ---------------------------------------------------------------------------
// Field mapping config
// ---------------------------------------------------------------------------

interface FieldDef {
  key: string;
  label: string;
  suggested: string; // default HubSpot property name
}

const FIELD_DEFS: Record<"account" | "contact" | "deal", FieldDef[]> = {
  account: [
    { key: "name", label: "Name", suggested: "name" },
    { key: "domain", label: "Domain", suggested: "domain" },
    { key: "industry", label: "Industry", suggested: "industry" },
  ],
  contact: [
    { key: "firstName", label: "First name", suggested: "firstname" },
    { key: "lastName", label: "Last name", suggested: "lastname" },
    { key: "email", label: "Email", suggested: "email" },
  ],
  deal: [
    { key: "name", label: "Name", suggested: "dealname" },
    { key: "stage", label: "Stage", suggested: "dealstage" },
    { key: "amountCents", label: "Amount", suggested: "amount" },
  ],
};

const HUBSPOT_PROPERTY_SUGGESTIONS: string[] = [
  "name",
  "domain",
  "industry",
  "firstname",
  "lastname",
  "email",
  "phone",
  "jobtitle",
  "company",
  "dealname",
  "dealstage",
  "amount",
  "closedate",
  "pipeline",
  "numberofemployees",
];

const SYNC_DIRECTIONS: Array<{ value: HubspotSyncDirection; label: string; description: string }> = [
  { value: "read", label: "Read-only", description: "Pull records from HubSpot into AgentDash" },
  { value: "write", label: "Write-only", description: "Push AgentDash changes to HubSpot" },
  {
    value: "bidirectional",
    label: "Bidirectional",
    description: "Sync changes both directions",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "Never";
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function buildDefaultMapping(): HubspotFieldMapping {
  const mapping: HubspotFieldMapping = {};
  for (const [entity, fields] of Object.entries(FIELD_DEFS)) {
    mapping[entity] = {};
    for (const f of fields) {
      mapping[entity][f.key] = f.suggested;
    }
  }
  return mapping;
}

function mergeMapping(
  base: HubspotFieldMapping,
  incoming: HubspotFieldMapping | undefined,
): HubspotFieldMapping {
  if (!incoming) return base;
  const merged: HubspotFieldMapping = {};
  for (const [entity, fields] of Object.entries(base)) {
    merged[entity] = { ...fields, ...(incoming[entity] ?? {}) };
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HubSpotSettings() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([
      { label: "CRM", href: "/crm/pipeline" },
      { label: "HubSpot Integration" },
    ]);
  }, [setBreadcrumbs]);

  const configKey = useMemo(
    () => ["crm", selectedCompanyId ?? "_none_", "hubspot", "config"] as const,
    [selectedCompanyId],
  );
  const syncStatusKey = useMemo(
    () => ["crm", selectedCompanyId ?? "_none_", "hubspot", "sync-status"] as const,
    [selectedCompanyId],
  );

  const configQuery = useQuery({
    queryKey: configKey,
    queryFn: () => crmApi.hubspotConfig(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const config = configQuery.data;
  const isConnected = !!config?.configured;

  const syncStatusQuery = useQuery({
    queryKey: syncStatusKey,
    queryFn: () => crmApi.hubspotSyncStatus(selectedCompanyId!),
    enabled: !!selectedCompanyId && isConnected,
  });

  // Form drafts
  const [accessTokenDraft, setAccessTokenDraft] = useState("");
  const [portalIdDraft, setPortalIdDraft] = useState("");
  const [syncDirectionDraft, setSyncDirectionDraft] =
    useState<HubspotSyncDirection>("bidirectional");
  const [mappingDraft, setMappingDraft] = useState<HubspotFieldMapping>(buildDefaultMapping());

  // Hydrate drafts when config loads / changes
  useEffect(() => {
    if (!config) return;
    if (config.portalId) setPortalIdDraft(config.portalId);
    if (config.syncDirection) setSyncDirectionDraft(config.syncDirection);
    setMappingDraft((prev) => mergeMapping(prev, config.fieldMapping));
  }, [config]);

  const saveMutation = useMutation({
    mutationFn: (body: {
      accessToken: string;
      portalId: string;
      syncDirection: HubspotSyncDirection;
      fieldMapping: HubspotFieldMapping;
    }) =>
      crmApi.saveHubspotConfig(selectedCompanyId!, {
        accessToken: body.accessToken,
        portalId: body.portalId || undefined,
        syncEnabled: true,
        syncDirection: body.syncDirection,
        fieldMapping: body.fieldMapping,
      }),
    onSuccess: () => {
      setAccessTokenDraft("");
      queryClient.invalidateQueries({ queryKey: configKey });
      pushToast({ tone: "success", title: "HubSpot configuration saved" });
    },
    onError: (err) => {
      pushToast({
        tone: "error",
        title: "Failed to save configuration",
        body: err instanceof Error ? err.message : "Unknown error",
      });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: () => crmApi.disconnectHubspot(selectedCompanyId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: configKey });
      queryClient.invalidateQueries({ queryKey: syncStatusKey });
      pushToast({ tone: "success", title: "Disconnected from HubSpot" });
    },
    onError: (err) => {
      pushToast({
        tone: "error",
        title: "Failed to disconnect",
        body: err instanceof Error ? err.message : "Unknown error",
      });
    },
  });

  const testMutation = useMutation({
    mutationFn: () => crmApi.testHubspotConnection(selectedCompanyId!),
    onSuccess: (result) => {
      if (result.ok) {
        pushToast({ tone: "success", title: "HubSpot connection works" });
      } else {
        pushToast({
          tone: "error",
          title: "Connection failed",
          body: result.error ?? "Unknown error",
        });
      }
    },
    onError: (err) => {
      pushToast({
        tone: "error",
        title: "Connection test failed",
        body: err instanceof Error ? err.message : "Unknown error",
      });
    },
  });

  const syncMutation = useMutation({
    mutationFn: () => crmApi.syncHubspot(selectedCompanyId!),
    onSuccess: (summary) => {
      queryClient.invalidateQueries({ queryKey: syncStatusKey });
      pushToast({
        tone: summary.totalErrors > 0 ? "warn" : "success",
        title: `Sync complete: ${summary.totalSynced} records`,
        body:
          summary.totalErrors > 0
            ? `${summary.totalErrors} error(s). Contacts ${summary.contacts}, companies ${summary.companies}, deals ${summary.deals}, activities ${summary.activities}.`
            : `Contacts ${summary.contacts}, companies ${summary.companies}, deals ${summary.deals}, activities ${summary.activities}.`,
      });
    },
    onError: (err) => {
      pushToast({
        tone: "error",
        title: "Sync failed",
        body: err instanceof Error ? err.message : "Unknown error",
      });
    },
  });

  // ── Guards ────────────────────────────────────────────────────────────
  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground p-6">Select a company first.</p>;
  }

  if (configQuery.isLoading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-10 w-1/2" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const saveBusy = saveMutation.isPending;
  const disconnectBusy = disconnectMutation.isPending;
  const testBusy = testMutation.isPending;
  const syncBusy = syncMutation.isPending;

  const canSave =
    (isConnected || accessTokenDraft.trim().length > 0) && !saveBusy;

  const handleSave = () => {
    // When already connected, token can stay redacted; we require a new token
    // only on first connection.
    const token = accessTokenDraft.trim();
    if (!isConnected && !token) {
      pushToast({
        tone: "error",
        title: "Access token required",
        body: "Paste a HubSpot private-app access token to connect.",
      });
      return;
    }
    saveMutation.mutate({
      accessToken: token || (config?.accessToken ?? ""),
      portalId: portalIdDraft.trim(),
      syncDirection: syncDirectionDraft,
      fieldMapping: mappingDraft,
    });
  };

  const updateMapping = (entity: string, field: string, value: string) => {
    setMappingDraft((prev) => ({
      ...prev,
      [entity]: { ...(prev[entity] ?? {}), [field]: value },
    }));
  };

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded bg-muted text-muted-foreground shrink-0">
          <Plug className="h-6 w-6" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-semibold">HubSpot Integration</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Connect AgentDash to HubSpot to sync accounts, contacts, deals, and activities.
          </p>
        </div>
        <div className="shrink-0">
          {isConnected ? (
            <span
              data-testid="hubspot-status-badge"
              className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700"
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              Connected
            </span>
          ) : (
            <span
              data-testid="hubspot-status-badge"
              className="inline-flex items-center gap-1 rounded-full bg-muted px-3 py-1 text-xs font-medium text-muted-foreground"
            >
              <XCircle className="h-3.5 w-3.5" />
              Not connected
            </span>
          )}
        </div>
      </div>

      {/* Connection section */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Connection
        </h2>

        <div className="border border-border rounded-md p-4 space-y-4">
          {isConnected ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-muted-foreground">Portal ID</p>
                <p className="text-sm font-medium mt-0.5">{config?.portalId || "—"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Access token</p>
                <p className="text-sm font-mono mt-0.5">{config?.accessToken ?? "—"}</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Paste an access token from a HubSpot private app. AgentDash does not require
              OAuth — use a token scoped to crm.objects.contacts, companies, deals, and
              engagements.
            </p>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="text-sm space-y-1">
              <span className="text-xs font-medium text-muted-foreground">
                {isConnected ? "Replace access token (optional)" : "Access token"}
              </span>
              <input
                type="password"
                data-testid="hubspot-access-token"
                value={accessTokenDraft}
                onChange={(e) => setAccessTokenDraft(e.target.value)}
                placeholder="pat-na1-..."
                className="mt-0.5 h-9 w-full px-2 text-sm border border-border bg-background rounded-md font-mono"
              />
            </label>
            <label className="text-sm space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Portal ID</span>
              <input
                type="text"
                data-testid="hubspot-portal-id"
                value={portalIdDraft}
                onChange={(e) => setPortalIdDraft(e.target.value)}
                placeholder="e.g. 43210987"
                className="mt-0.5 h-9 w-full px-2 text-sm border border-border bg-background rounded-md"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-2">
            <Button
              size="sm"
              data-testid="hubspot-save"
              onClick={handleSave}
              disabled={!canSave}
            >
              {saveBusy ? (
                <>
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  Saving…
                </>
              ) : isConnected ? (
                "Save changes"
              ) : (
                <>
                  <Link2 className="mr-1 h-3.5 w-3.5" />
                  Connect HubSpot
                </>
              )}
            </Button>
            {isConnected && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="hubspot-test-connection"
                  onClick={() => testMutation.mutate()}
                  disabled={testBusy}
                >
                  {testBusy ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  Test connection
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="hubspot-sync-now"
                  onClick={() => syncMutation.mutate()}
                  disabled={syncBusy}
                >
                  {syncBusy ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-1 h-3.5 w-3.5" />
                  )}
                  Sync now
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="hubspot-disconnect"
                  onClick={() => disconnectMutation.mutate()}
                  disabled={disconnectBusy}
                  className="text-destructive"
                >
                  {disconnectBusy ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Link2Off className="mr-1 h-3.5 w-3.5" />
                  )}
                  Disconnect
                </Button>
              </>
            )}
          </div>
        </div>
      </section>

      {/* Sync direction */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Sync direction
        </h2>
        <div
          role="radiogroup"
          data-testid="hubspot-sync-direction"
          className="grid grid-cols-1 sm:grid-cols-3 gap-3"
        >
          {SYNC_DIRECTIONS.map((dir) => {
            const active = syncDirectionDraft === dir.value;
            return (
              <label
                key={dir.value}
                className={`cursor-pointer border rounded-md p-3 text-sm transition-colors ${
                  active
                    ? "border-primary bg-primary/5 ring-1 ring-primary"
                    : "border-border hover:bg-muted/40"
                }`}
              >
                <input
                  type="radio"
                  name="hubspot-sync-direction"
                  value={dir.value}
                  checked={active}
                  onChange={() => setSyncDirectionDraft(dir.value)}
                  className="sr-only"
                  data-testid={`hubspot-sync-direction-${dir.value}`}
                />
                <p className="font-medium">{dir.label}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{dir.description}</p>
              </label>
            );
          })}
        </div>
      </section>

      {/* Field mapping */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Field mapping
        </h2>
        <p className="text-xs text-muted-foreground">
          Map each AgentDash CRM field to its HubSpot property name.
        </p>
        <div className="space-y-4">
          {(["account", "contact", "deal"] as const).map((entity) => (
            <div key={entity} className="border border-border rounded-md p-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                {entity === "account" ? "Account" : entity === "contact" ? "Contact" : "Deal"}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {FIELD_DEFS[entity].map((field) => {
                  const current =
                    mappingDraft[entity]?.[field.key] ?? field.suggested;
                  return (
                    <label key={field.key} className="text-sm space-y-1">
                      <span className="text-xs font-medium text-muted-foreground">
                        {field.label}
                      </span>
                      <select
                        data-testid={`hubspot-field-${entity}-${field.key}`}
                        value={current}
                        onChange={(e) => updateMapping(entity, field.key, e.target.value)}
                        className="mt-0.5 h-8 w-full px-2 text-sm border border-border bg-background rounded-md"
                      >
                        {/* Include the current value so free-form mapping survives */}
                        {!HUBSPOT_PROPERTY_SUGGESTIONS.includes(current) && (
                          <option value={current}>{current}</option>
                        )}
                        {HUBSPOT_PROPERTY_SUGGESTIONS.map((prop) => (
                          <option key={prop} value={prop}>
                            {prop}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Sync status */}
      {isConnected && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Sync status
          </h2>
          <div
            data-testid="hubspot-sync-status"
            className="border border-border rounded-md p-4 space-y-3"
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Last synced</p>
                <p className="font-medium mt-0.5">
                  {formatDateTime(syncStatusQuery.data?.lastSyncAt ?? null)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Status</p>
                <p className="font-medium mt-0.5">
                  {syncStatusQuery.data?.syncInProgress
                    ? "In progress"
                    : syncStatusQuery.data?.lastSyncError
                      ? "Error"
                      : "Idle"}
                </p>
              </div>
            </div>

            {syncStatusQuery.data?.lastSyncError && (
              <p className="text-sm text-destructive">
                {syncStatusQuery.data.lastSyncError}
              </p>
            )}

            {syncStatusQuery.data?.lastSyncResult && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {(
                  [
                    ["Accounts", syncStatusQuery.data.lastSyncResult.companies.synced],
                    ["Contacts", syncStatusQuery.data.lastSyncResult.contacts.synced],
                    ["Deals", syncStatusQuery.data.lastSyncResult.deals.synced],
                    ["Activities", syncStatusQuery.data.lastSyncResult.activities.synced],
                  ] as const
                ).map(([label, count]) => (
                  <div key={label} className="border border-border rounded-md p-2 text-center">
                    <p className="text-lg font-semibold">{count}</p>
                    <p className="text-xs text-muted-foreground">{label}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

// Keep the named export type signature of HubspotConfig referenced to avoid
// accidental drift between routes and this page.
export type { HubspotConfig };
