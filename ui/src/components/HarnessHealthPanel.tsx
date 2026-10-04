import type { DashboardHarnessAdapterHealth, DashboardHarnessHealth, DashboardHarnessStatus } from "@paperclipai/shared";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import { cn } from "../lib/utils";

/**
 * AgentDash (c4 trust): adapter keys are internal identifiers — "hermes
 * local" in the hosted feed meant nothing to an owner. Name the harness the
 * person actually picked at hire time.
 */
const ADAPTER_TYPE_LABELS: Record<string, string> = {
  process: "Local process",
  http: "HTTP",
  acpx_local: "ACPX (local)",
  claude_api: "Claude API",
  claude_local: "Claude Code (local)",
  codex_local: "Codex (local)",
  gemini_local: "Gemini (local)",
  hermes_local: "Hermes (local)",
  opencode_local: "OpenCode (local)",
  pi_local: "Pi (local)",
  cursor: "Cursor",
  openclaw_gateway: "OpenClaw",
};

function formatAdapterType(value: string) {
  return ADAPTER_TYPE_LABELS[value]
    ?? value.replace(/[_-]+/g, " ").replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

function formatCategory(value: string | null) {
  return value ? value.replace(/[_-]+/g, " ") : "none";
}

function statusTone(status: DashboardHarnessStatus) {
  if (status === "critical") {
    return "border-red-500/30 bg-red-500/10 text-red-900 dark:text-red-200";
  }
  if (status === "warn") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200";
  }
  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200";
}

function statusLabel(status: DashboardHarnessStatus) {
  if (status === "critical") return "Critical";
  if (status === "warn") return "Watch";
  return "Healthy";
}

function HarnessAdapterRow({ adapter }: { adapter: DashboardHarnessAdapterHealth }) {
  return (
    <div className="grid gap-2 border-t border-border/70 py-2 text-xs text-muted-foreground sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:items-center">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="font-medium text-foreground">{formatAdapterType(adapter.adapterType)}</span>
          <span className={cn("rounded-md border px-1.5 py-0.5 text-[11px] font-medium", statusTone(adapter.status))}>
            {statusLabel(adapter.status)}
          </span>
        </div>
        {/* AgentDash (c4 trust): "Top category: quota_limit" read as internal
            jargon to a non-technical owner. */}
        <p className="mt-1 min-w-0 break-words text-[11px]">
          Most common failure: <span>{formatCategory(adapter.topFailureCategory)}</span>
          {adapter.latestFailureAt ? ` · Latest failure ${new Date(adapter.latestFailureAt).toLocaleString()}` : ""}
        </p>
      </div>
      <div className="tabular-nums">
        <span className="font-medium text-foreground">{adapter.failureRatePercent}%</span> failed
      </div>
      <div className="tabular-nums">
        <span className="font-medium text-foreground">{adapter.failedRuns}</span>/{adapter.totalRuns} runs
      </div>
      <div className="tabular-nums">
        <span className="font-medium text-foreground">{adapter.agents}</span>{" "}
        {adapter.agents === 1 ? "agent" : "agents"}
      </div>
    </div>
  );
}

export function HarnessHealthPanel({ health }: { health: DashboardHarnessHealth }) {
  const Icon = health.overallStatus === "ok" ? ShieldCheck : AlertTriangle;
  return (
    <section className={cn("rounded-lg border px-4 py-3", statusTone(health.overallStatus))}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 shrink-0" />
            <h3 className="text-sm font-medium">Run reliability</h3>
          </div>
          <p className="mt-1 text-xs opacity-80">
            How often agent runs failed in the last {health.windowHours} hours, by agent type.
          </p>
        </div>
        <div className="text-right tabular-nums">
          <p className="text-xl font-semibold">{health.failureRatePercent}%</p>
          <p className="text-[11px] opacity-80">
            {health.failedRuns}/{health.totalRuns} failed
          </p>
        </div>
      </div>

      {health.adapters.length === 0 ? (
        <p className="mt-3 rounded-md border border-current/15 bg-background/50 px-2 py-2 text-xs">
          No agent runs finished in the last {health.windowHours} hours.
        </p>
      ) : (
        <div className="mt-3">
          {health.adapters.map((adapter) => (
            <HarnessAdapterRow key={adapter.adapterType} adapter={adapter} />
          ))}
        </div>
      )}
    </section>
  );
}
