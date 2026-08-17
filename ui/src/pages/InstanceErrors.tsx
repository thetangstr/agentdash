import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BellOff, BellRing, CheckCircle2 } from "lucide-react";
import { serverErrorsApi, type ServerErrorRow } from "@/api/server-errors";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";

/**
 * O2 (2026-08-16): where a person finds out.
 *
 * The errors themselves never leave this machine — alert emails carry a
 * one-line summary and a link back here, never a request body. This is the
 * page that link points at.
 */

function relative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function ErrorCard({ row, onClear }: { row: ServerErrorRow; onClear: (fp: string) => void }) {
  const ctx = row.lastContext ?? {};
  return (
    <div className="rounded-lg border border-border p-4" data-testid="server-error-row">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{row.name}</span>
            {row.count > 1 && (
              <span
                className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
                data-testid="server-error-count"
              >
                {row.count}×
              </span>
            )}
          </div>
          <p className="break-words text-sm text-muted-foreground">{row.message}</p>
          <p className="text-xs text-muted-foreground">
            {[ctx.method, ctx.url, ctx.status ? `→ ${ctx.status}` : null, ctx.kind]
              .filter(Boolean)
              .join(" ")}
          </p>
          <p className="text-xs text-muted-foreground">
            first {relative(row.firstSeen)} · last {relative(row.lastSeen)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onClear(row.fingerprint)}
          className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm"
          title="Clear this error. If it happens again it comes back with a fresh first-seen — which is the honest signal that the fix did not hold."
        >
          Clear
        </button>
      </div>
      {row.stack && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-muted-foreground">Stack</summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 text-xs">{row.stack}</pre>
        </details>
      )}
    </div>
  );
}

export function InstanceErrors() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Instance" }, { label: "Errors" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["instance", "errors"],
    queryFn: () => serverErrorsApi.list(),
    refetchInterval: 60_000,
  });

  const clear = useMutation({
    mutationFn: (fingerprint: string) => serverErrorsApi.clear(fingerprint),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["instance", "errors"] }),
  });

  if (isLoading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (error) {
    return (
      <div className="text-sm text-muted-foreground">
        Could not load errors. This page is instance-admin only.
      </div>
    );
  }

  const rows = data?.errors ?? [];
  const alerter = data?.alerter;
  const checks = data?.checks;

  return (
    <div className="max-w-4xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Errors</h1>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Every server error on this instance, grouped so one repeated fault is one row rather
          than thousands. Details stay on this machine; alerts carry only a summary and a link here.
        </p>
      </div>

      {/* Would anyone have been told? The question this project kept getting wrong. */}
      <div className="rounded-lg border border-border p-4" data-testid="alerter-status">
        <div className="flex items-center gap-2">
          {alerter?.configured ? (
            <BellRing className="h-4 w-4 text-muted-foreground" />
          ) : (
            <BellOff className="h-4 w-4 text-muted-foreground" />
          )}
          <span className="text-sm font-medium">
            {alerter?.configured ? "Alerting is on" : "Alerting is NOT configured"}
          </span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {alerter?.configured
            ? `${alerter.sentSinceBoot} sent since boot, ${alerter.debouncedSinceBoot} folded as repeats.`
            : "Failures are recorded here but nobody is emailed. Set AGENTDASH_ALERT_RESEND_API_KEY, _FROM and _TO."}
          {alerter && alerter.droppedSinceBoot > 0 && (
            <span data-testid="alerter-dropped">
              {" "}
              {alerter.droppedSinceBoot} alert(s) could not be delivered
              {alerter.lastSendError ? ` (${alerter.lastSendError})` : ""}.
            </span>
          )}
        </p>
      </div>

      {checks && (
        <div className="rounded-lg border border-border p-4 text-sm" data-testid="health-checks">
          <span className="font-medium">
            System {checks.status === "ok" ? "healthy" : "degraded"}
          </span>
          <ul className="mt-2 space-y-1 text-muted-foreground">
            <li>Database {checks.db.latencyMs}ms</li>
            <li>Disk {(checks.disk.freeBytes / 1e9).toFixed(1)} GB free{checks.disk.ok ? "" : " — LOW"}</li>
            <li>
              {checks.backup
                ? `Newest backup ${checks.backup.ageHours ?? "?"}h old${checks.backup.ok ? "" : " — STALE"}`
                : "No backup directory for this instance"}
            </li>
            <li>{checks.runs.stuck} stuck run(s)</li>
          </ul>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="flex items-center gap-2 rounded-lg border border-border p-4 text-sm text-muted-foreground">
          <CheckCircle2 className="h-4 w-4" />
          No errors recorded.
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <ErrorCard key={row.fingerprint} row={row} onClear={(fp) => clear.mutate(fp)} />
          ))}
        </div>
      )}
    </div>
  );
}
