import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";

export function HubSpotSettings() {
  const { selectedCompany } = useCompany();
  const cid = selectedCompany?.id;
  const queryClient = useQueryClient();

  const [accessToken, setAccessToken] = useState("");
  const [portalId, setPortalId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  const { data: config, isLoading: configLoading } = useQuery({
    queryKey: ["hubspot-config", cid],
    queryFn: async () => {
      const r = await fetch(`/api/companies/${cid}/integrations/hubspot/config`);
      return r.json();
    },
    enabled: !!cid,
  });

  const { data: syncStatus, refetch: refetchStatus } = useQuery({
    queryKey: ["hubspot-sync-status", cid],
    queryFn: async () => {
      const r = await fetch(`/api/companies/${cid}/integrations/hubspot/sync/status`);
      return r.json();
    },
    enabled: !!cid,
    refetchInterval: (query) => {
      const data = query.state.data as { syncInProgress?: boolean } | undefined;
      return data?.syncInProgress ? 2000 : false;
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = { accessToken, portalId, syncEnabled };
      if (clientSecret) body.clientSecret = clientSecret;
      const r = await fetch(`/api/companies/${cid}/integrations/hubspot/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? "Save failed");
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["hubspot-config", cid] });
      setTestResult(null);
    },
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/companies/${cid}/integrations/hubspot/test`, { method: "POST" });
      return r.json();
    },
    onSuccess: (data) => setTestResult(data),
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/companies/${cid}/integrations/hubspot/sync`, { method: "POST" });
      if (!r.ok) throw new Error((await r.json()).error ?? "Sync failed");
      return r.json();
    },
    onSuccess: () => {
      refetchStatus();
      queryClient.invalidateQueries({ queryKey: ["crm-pipeline", cid] });
      queryClient.invalidateQueries({ queryKey: ["crm-deals", cid] });
      queryClient.invalidateQueries({ queryKey: ["crm-accounts", cid] });
      queryClient.invalidateQueries({ queryKey: ["crm-contacts", cid] });
      queryClient.invalidateQueries({ queryKey: ["crm-leads", cid] });
    },
    onSettled: () => refetchStatus(),
  });

  if (!cid) return <div className="p-6 text-muted-foreground">Select a company</div>;
  if (configLoading) return <div className="p-6 text-muted-foreground">Loading...</div>;

  const isConfigured = config?.configured === true;

  return (
    <div className="p-6 space-y-8 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold">HubSpot Integration</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Connect your HubSpot account to sync contacts, companies, deals, and activities.
        </p>
      </div>

      {/* Connection */}
      <div className="rounded-xl border bg-card p-6 space-y-4">
        <h2 className="text-lg font-semibold">Connection</h2>

        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">Access Token</label>
            <input
              type="password"
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm"
              placeholder={isConfigured ? config.accessToken : "pat-na1-xxxxxxxx-xxxx..."}
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
            />
            <p className="text-xs text-muted-foreground mt-1">
              Create a Private App in HubSpot Settings &gt; Integrations &gt; Private Apps
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Portal ID</label>
            <input
              type="text"
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm"
              placeholder={isConfigured ? config.portalId : "12345678"}
              value={portalId}
              onChange={(e) => setPortalId(e.target.value)}
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">Client Secret (optional, for webhook verification)</label>
            <input
              type="password"
              className="w-full rounded-lg border bg-background px-3 py-2 text-sm"
              placeholder={isConfigured && config.hasClientSecret ? "****configured" : "Optional"}
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
            onClick={() => saveMutation.mutate()}
            disabled={!accessToken || saveMutation.isPending}
          >
            {saveMutation.isPending ? "Saving..." : "Save"}
          </button>

          <button
            className="px-4 py-2 rounded-lg border text-sm font-medium hover:bg-muted disabled:opacity-50"
            onClick={() => testMutation.mutate()}
            disabled={!isConfigured || testMutation.isPending}
          >
            {testMutation.isPending ? "Testing..." : "Test Connection"}
          </button>

          {testResult && (
            <span className={`text-sm font-medium ${testResult.ok ? "text-emerald-600" : "text-red-600"}`}>
              {testResult.ok ? "Connected" : testResult.error ?? "Connection failed"}
            </span>
          )}

          {saveMutation.isSuccess && (
            <span className="text-sm font-medium text-emerald-600">Saved</span>
          )}
          {saveMutation.isError && (
            <span className="text-sm font-medium text-red-600">
              {(saveMutation.error as Error).message}
            </span>
          )}
        </div>
      </div>

      {/* Sync Options */}
      <div className="rounded-xl border bg-card p-6 space-y-4">
        <h2 className="text-lg font-semibold">Sync Options</h2>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={syncEnabled}
            onChange={(e) => setSyncEnabled(e.target.checked)}
            className="rounded"
          />
          Enable automatic sync
        </label>
        <p className="text-xs text-muted-foreground">
          When enabled, contacts, companies, deals, and activities sync hourly from HubSpot.
        </p>
      </div>

      {/* Sync Status */}
      {isConfigured && (
        <div className="rounded-xl border bg-card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Sync Status</h2>
            <button
              className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending || syncStatus?.syncInProgress}
            >
              {syncMutation.isPending || syncStatus?.syncInProgress ? "Syncing..." : "Sync Now"}
            </button>
          </div>

          {syncStatus?.syncInProgress && (
            <div className="flex items-center gap-2 text-sm text-amber-600">
              <span className="inline-block h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
              Sync in progress...
            </div>
          )}

          {syncStatus?.lastSyncAt && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Last synced: {formatRelativeTime(syncStatus.lastSyncAt)}
              </p>

              {syncStatus.lastSyncResult && (
                <div className="grid gap-2 sm:grid-cols-4">
                  {(["contacts", "companies", "deals", "activities"] as const).map((key) => {
                    const r = syncStatus.lastSyncResult?.[key];
                    if (!r) return null;
                    return (
                      <div key={key} className="rounded-lg border p-3">
                        <p className="text-xs text-muted-foreground capitalize">{key}</p>
                        <p className="text-lg font-bold">{r.synced}</p>
                        {r.errors > 0 && (
                          <p className="text-xs text-red-500">{r.errors} errors</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {syncStatus?.lastSyncError && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3">
              <p className="text-sm text-red-700">{syncStatus.lastSyncError}</p>
            </div>
          )}

          {!syncStatus?.lastSyncAt && !syncStatus?.syncInProgress && (
            <p className="text-sm text-muted-foreground">No syncs yet. Click "Sync Now" to pull data from HubSpot.</p>
          )}

          {syncMutation.isError && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3">
              <p className="text-sm text-red-700">{(syncMutation.error as Error).message}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
