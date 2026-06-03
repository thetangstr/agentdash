import { cn } from "../lib/utils";

export type AgentRunFailureClassification = {
  category: string;
  severity: string;
  title: string;
  detail: string;
  nextActions: string[];
};

export type AgentRunFailureGuidanceAction = {
  label?: string;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  pending?: boolean;
  title?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

export function readAgentRunFailureClassification(resultJson: unknown): AgentRunFailureClassification | null {
  const result = asRecord(resultJson);
  const failure = asRecord(result?.failureClassification);
  if (!failure) return null;

  const title = readString(failure.title);
  const detail = readString(failure.detail);
  const category = readString(failure.category);
  const severity = readString(failure.severity);
  if (!title || !detail || !category || !severity) return null;

  return {
    title,
    detail,
    category,
    severity,
    nextActions: readStringArray(failure.nextActions),
  };
}

function guidanceTone(failure: AgentRunFailureClassification) {
  if (failure.severity === "customer_action_required") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200";
  }
  if (failure.severity === "transient") {
    return "border-cyan-500/30 bg-cyan-500/10 text-cyan-900 dark:text-cyan-200";
  }
  if (failure.severity === "operator_action_required") {
    return "border-orange-500/30 bg-orange-500/10 text-orange-900 dark:text-orange-200";
  }
  return "border-red-500/30 bg-red-500/10 text-red-900 dark:text-red-200";
}

export function failureClassificationBadgeTone(failure: AgentRunFailureClassification) {
  if (failure.severity === "transient") {
    return "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300";
  }
  if (failure.severity === "customer_action_required") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  if (failure.severity === "operator_action_required") {
    return "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300";
  }
  return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300";
}

export function recoveryActionLabel(action: string) {
  const labels: Record<string, string> = {
    retry: "Retry",
    wait_and_retry: "Wait and retry",
    open_credentials: "Open credentials",
    run_adapter_test: "Run adapter test",
    switch_model_or_adapter: "Switch model or adapter",
    fix_workspace: "Fix workspace",
    fix_permissions: "Fix permissions",
    escalate_support: "Escalate support",
  };
  return labels[action] ?? action.replace(/[_-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function AgentRunFailureGuidance({
  classification,
  actions,
  className,
}: {
  classification: AgentRunFailureClassification;
  actions?: Partial<Record<string, AgentRunFailureGuidanceAction>>;
  className?: string;
}) {
  return (
    <div className={cn("rounded-md border px-2 py-2 text-xs leading-5", guidanceTone(classification), className)}>
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <p className="font-medium">Harness recovery</p>
        <span className="font-mono text-[11px] opacity-80">
          {classification.category.replace(/_/g, " ")}
        </span>
      </div>
      <p className="mt-1 font-medium">{classification.title}</p>
      <p className="mt-1 break-words">{classification.detail}</p>
      {classification.nextActions.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {classification.nextActions.map((action) => {
            const wiredAction = actions?.[action];
            const label = wiredAction?.label ?? recoveryActionLabel(action);
            const actionClassName = cn(
              "rounded-md border border-current/25 bg-background/60 px-2 py-1 text-[11px] font-medium",
              wiredAction && !wiredAction.disabled && "hover:bg-background/80",
              wiredAction?.disabled && "cursor-not-allowed opacity-60",
            );
            if (wiredAction?.href && !wiredAction.disabled) {
              return (
                <a
                  key={action}
                  href={wiredAction.href}
                  title={wiredAction.title}
                  className={actionClassName}
                >
                  {wiredAction.pending ? `${label}...` : label}
                </a>
              );
            }
            if (wiredAction?.onClick) {
              return (
                <button
                  key={action}
                  type="button"
                  title={wiredAction.title}
                  className={actionClassName}
                  onClick={wiredAction.onClick}
                  disabled={wiredAction.disabled || wiredAction.pending}
                >
                  {wiredAction.pending ? `${label}...` : label}
                </button>
              );
            }
            return (
              <span key={action} className={actionClassName} title={wiredAction?.title}>
                {wiredAction?.pending ? `${label}...` : label}
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
