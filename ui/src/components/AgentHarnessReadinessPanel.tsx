import { AlertTriangle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";

type HarnessCheck = {
  code: string;
  level: string;
  message: string;
  hint?: string | null;
};

export type AgentHarnessPreflightStatus = {
  state: "missing" | "pass" | "warn" | "fail" | "malformed";
  title: string;
  message: string;
  adapterType: string | null;
  testedAt: string | null;
  checks: HarnessCheck[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readChecks(value: unknown): HarnessCheck[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const code = readString(record?.code);
    const level = readString(record?.level);
    const message = readString(record?.message);
    if (!code || !level || !message) return [];
    return [{
      code,
      level,
      message,
      hint: readString(record?.hint),
    }];
  });
}

function formatAdapterType(value: string | null) {
  return value ? value.replace(/[_-]+/g, " ") : "adapter";
}

export function readAgentHarnessPreflightStatus(metadata: unknown): AgentHarnessPreflightStatus {
  const record = asRecord(metadata);
  const harness = asRecord(record?.harnessPreflight);
  if (!harness) {
    return {
      state: "missing",
      title: "Harness preflight required",
      message: "Run preflight against the saved agent configuration before assigning customer work.",
      adapterType: null,
      testedAt: null,
      checks: [],
    };
  }

  const status = readString(harness.status);
  const adapterType = readString(harness.adapterType);
  const testedAt = readString(harness.testedAt);
  const configDigest = readString(harness.configDigest);
  const checks = readChecks(harness.checks);
  if (!status || !adapterType || !testedAt || !configDigest) {
    return {
      state: "malformed",
      title: "Harness preflight evidence is incomplete",
      message: "Run preflight again so launch-mode checks can verify this saved agent configuration.",
      adapterType,
      testedAt,
      checks,
    };
  }

  if (status === "pass") {
    return {
      state: "pass",
      title: "Harness preflight passed",
      message: "Saved evidence is present for this adapter configuration. Launch mode will still re-check that it matches before a run starts.",
      adapterType,
      testedAt,
      checks,
    };
  }

  return {
    state: status === "warn" ? "warn" : "fail",
    title: status === "warn" ? "Harness preflight has warnings" : "Harness preflight failed",
    message: "Resolve the checks below, then run preflight again before assigning customer work.",
    adapterType,
    testedAt,
    checks,
  };
}

function toneForState(state: AgentHarnessPreflightStatus["state"]) {
  if (state === "pass") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200";
  if (state === "warn") return "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200";
  return "border-red-500/30 bg-red-500/10 text-red-900 dark:text-red-200";
}

export function AgentHarnessReadinessPanel({
  status,
  onRunPreflight,
  pending,
  error,
  className,
}: {
  status: AgentHarnessPreflightStatus;
  onRunPreflight?: () => void;
  pending?: boolean;
  error?: string | null;
  className?: string;
}) {
  const Icon = status.state === "pass" ? ShieldCheck : AlertTriangle;
  return (
    <section className={cn("rounded-lg border px-4 py-3 text-sm", toneForState(status.state), className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 shrink-0" />
            <h3 className="font-medium">{status.title}</h3>
          </div>
          <p className="mt-1 text-xs opacity-85">{status.message}</p>
          <p className="mt-2 text-[11px] opacity-80">
            {formatAdapterType(status.adapterType)}
            {status.testedAt ? ` · Saved evidence ${new Date(status.testedAt).toLocaleString()}` : ""}
          </p>
        </div>
        {onRunPreflight ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 border-current/25 bg-background/50 px-2.5 text-xs hover:bg-background/75"
            onClick={onRunPreflight}
            disabled={pending}
          >
            {pending ? "Running..." : "Run preflight"}
          </Button>
        ) : null}
      </div>

      {error ? (
        <p className="mt-2 rounded-md border border-current/20 bg-background/50 px-2 py-1.5 text-xs">
          {error}
        </p>
      ) : null}

      {status.checks.length > 0 ? (
        <div className="mt-3 space-y-1.5">
          {status.checks.slice(0, 4).map((check) => (
            <div key={`${check.code}-${check.message}`} className="rounded-md border border-current/15 bg-background/50 px-2 py-1.5 text-xs">
              <span className="font-mono uppercase opacity-75">{check.level}</span>
              <span className="mx-1 opacity-60">·</span>
              <span>{check.message}</span>
              {check.hint ? <span className="block opacity-85">{check.hint}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
