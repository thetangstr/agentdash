import { UserPlus, Lightbulb, ShieldAlert, ShieldCheck, Bot, Scale } from "lucide-react";
import { formatCents } from "../lib/utils";

export const typeLabel: Record<string, string> = {
  hire_agent: "Hire Agent",
  approve_ceo_strategy: "CEO Strategy",
  budget_override_required: "Budget Override",
  action_proposal: "Action Proposal",
  spawn_agents: "Spawn Agents",
};

/** Build a contextual label for an approval, e.g. "Hire Agent: Designer" */
export function approvalLabel(type: string, payload?: Record<string, unknown> | null): string {
  const base = typeLabel[type] ?? type;
  if (type === "hire_agent" && payload?.name) {
    return `${base}: ${String(payload.name)}`;
  }
  if (type === "action_proposal" && payload?.actionType) {
    return `${base}: ${String(payload.actionType)}${payload.summary ? ` — ${String(payload.summary).slice(0, 60)}` : ""}`;
  }
  return base;
}

export const typeIcon: Record<string, typeof UserPlus> = {
  hire_agent: UserPlus,
  approve_ceo_strategy: Lightbulb,
  budget_override_required: ShieldAlert,
  action_proposal: Scale,
  spawn_agents: Bot,
};

export const defaultTypeIcon = ShieldCheck;

function PayloadField({ label, value }: { label: string; value: unknown }) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">{label}</span>
      <span>{String(value)}</span>
    </div>
  );
}

function SkillList({ values }: { values: unknown }) {
  if (!Array.isArray(values)) return null;
  const items = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  if (items.length === 0) return null;

  return (
    <div className="flex items-start gap-2">
      <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Skills</span>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span
            key={item}
            className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

export function HireAgentPayload({ payload }: { payload: Record<string, unknown> }) {
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Name</span>
        <span className="font-medium">{String(payload.name ?? "—")}</span>
      </div>
      <PayloadField label="Role" value={payload.role} />
      <PayloadField label="Title" value={payload.title} />
      <PayloadField label="Icon" value={payload.icon} />
      {!!payload.capabilities && (
        <div className="flex items-start gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Capabilities</span>
          <span className="text-muted-foreground">{String(payload.capabilities)}</span>
        </div>
      )}
      {!!payload.adapterType && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Adapter</span>
          <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
            {String(payload.adapterType)}
          </span>
        </div>
      )}
      <SkillList values={payload.desiredSkills} />
    </div>
  );
}

export function CeoStrategyPayload({ payload }: { payload: Record<string, unknown> }) {
  const plan = payload.plan ?? payload.description ?? payload.strategy ?? payload.text;
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Title" value={payload.title} />
      {!!plan && (
        <div className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground whitespace-pre-wrap font-mono text-xs max-h-48 overflow-y-auto">
          {String(plan)}
        </div>
      )}
      {!plan && (
        <pre className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground overflow-x-auto max-h-48">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function BudgetOverridePayload({ payload }: { payload: Record<string, unknown> }) {
  const budgetAmount = typeof payload.budgetAmount === "number" ? payload.budgetAmount : null;
  const observedAmount = typeof payload.observedAmount === "number" ? payload.observedAmount : null;
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Scope" value={payload.scopeName ?? payload.scopeType} />
      <PayloadField label="Window" value={payload.windowKind} />
      <PayloadField label="Metric" value={payload.metric} />
      {(budgetAmount !== null || observedAmount !== null) ? (
        <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Limit {budgetAmount !== null ? formatCents(budgetAmount) : "—"} · Observed {observedAmount !== null ? formatCents(observedAmount) : "—"}
        </div>
      ) : null}
      {!!payload.guidance && (
        <p className="text-muted-foreground">{String(payload.guidance)}</p>
      )}
    </div>
  );
}

// AgentDash: Action Proposal payload with evidence display
export function ActionProposalPayload({ payload }: { payload: Record<string, unknown> }) {
  const amount = typeof payload.amountCents === "number" ? payload.amountCents : null;
  const evidence = payload.evidence as Record<string, unknown> | undefined;
  const threshold = typeof payload.escalationThreshold === "number" ? payload.escalationThreshold : null;

  return (
    <div className="mt-3 space-y-3 text-sm">
      {/* Action summary */}
      <PayloadField label="Action" value={payload.actionType} />
      <PayloadField label="Summary" value={payload.summary} />
      {amount !== null && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-24 shrink-0 text-xs">Amount</span>
          <span className="text-lg font-bold text-emerald-600">{formatCents(amount)}</span>
          {threshold !== null && (
            <span className="text-xs text-amber-600 ml-2">
              (threshold: {formatCents(threshold)})
            </span>
          )}
        </div>
      )}
      {payload.confidenceScore != null && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-24 shrink-0 text-xs">Confidence</span>
          <span>{(Number(payload.confidenceScore) * 100).toFixed(0)}%</span>
        </div>
      )}

      {/* Policy decision */}
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground w-24 shrink-0 text-xs">Policy</span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
          String(payload.policyDecision) === "escalated" ? "bg-amber-100 text-amber-700"
            : String(payload.policyDecision) === "denied" ? "bg-red-100 text-red-700"
            : "bg-emerald-100 text-emerald-700"
        }`}>
          {String(payload.policyDecision ?? "—")}
        </span>
        {payload.policyDenialReason != null && (
          <span className="text-xs text-muted-foreground">{String(payload.policyDenialReason)}</span>
        )}
      </div>

      {/* Evidence packet */}
      {evidence && Object.keys(evidence).length > 0 && (
        <div className="mt-2">
          <p className="text-xs font-semibold text-muted-foreground mb-2">Evidence Packet</p>
          <div className="rounded-lg border bg-muted/30 divide-y">
            {Object.entries(evidence).map(([key, val]) => (
              <div key={key} className="px-3 py-2 flex items-start gap-2">
                <span className="text-xs font-medium text-muted-foreground w-24 shrink-0 capitalize">{key.replace(/_/g, " ")}</span>
                <span className="text-xs font-mono">
                  {typeof val === "object" && val !== null
                    ? JSON.stringify(val, null, 2)
                    : String(val ?? "—")}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* CRM links */}
      {(payload.crmAccountId != null || payload.crmContactId != null) && (
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {payload.crmAccountId != null && <span>{"Account: "}{String(payload.crmAccountId).slice(0, 8)}{"..."}</span>}
          {payload.crmContactId != null && <span>{"Contact: "}{String(payload.crmContactId).slice(0, 8)}{"..."}</span>}
        </div>
      )}
    </div>
  );
}

export function ApprovalPayloadRenderer({ type, payload }: { type: string; payload: Record<string, unknown> }) {
  if (type === "hire_agent") return <HireAgentPayload payload={payload} />;
  if (type === "action_proposal") return <ActionProposalPayload payload={payload} />;
  if (type === "budget_override_required") return <BudgetOverridePayload payload={payload} />;
  return <CeoStrategyPayload payload={payload} />;
}
