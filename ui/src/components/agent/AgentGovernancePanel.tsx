import {
  AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
  type AgentGovernancePolicy,
  type AgentPolicyViolation,
} from "@paperclipai/shared";
import type { AgentGovernanceRecord } from "../../api/agent-governance";

const WILDCARD = "*";

function describeList(values: string[]): string {
  if (values.includes(WILDCARD)) return "Unrestricted";
  if (values.length === 0) return "None";
  return values.join(", ");
}

function describeBudget(cents: number): string {
  // The unlimited sentinel is Postgres' integer max; showing it as a number
  // would read as a real (and alarming) spend limit.
  if (cents >= AGENT_POLICY_UNLIMITED_BUDGET_CENTS) return "Unrestricted";
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}/mo`;
}

/**
 * Formats a violation bound in the same units the table uses. Without this a
 * $100/mo ceiling renders as the raw `10000`, which reads as $10,000 — the
 * inverse of the sentinel problem `describeBudget` exists to avoid.
 */
export function formatBound(
  field: keyof AgentGovernancePolicy,
  allowed: string[] | string | number,
): string {
  if (field === "monthlyBudgetCents" && typeof allowed === "number") return describeBudget(allowed);
  if (Array.isArray(allowed)) return describeList(allowed);
  return String(allowed);
}

export const DIMENSION_LABELS: Record<keyof AgentGovernancePolicy, string> = {
  permissions: "Permissions",
  monthlyBudgetCents: "Monthly budget",
  destructiveActions: "Destructive actions",
  dataScopes: "Data scopes",
  providers: "Providers",
  minimumApproval: "Minimum approval",
};

/**
 * Human-readable statement of the bound a violation breached, in the same units
 * the table renders. Shared so the effective-vs-request banner and the
 * steward-request editor's per-field refusal read identically — the ceiling a
 * steward is shown when a save is refused is the exact ceiling the table shows.
 */
export function describeViolation(violation: AgentPolicyViolation): string {
  const bound = formatBound(violation.field, violation.allowed);
  return violation.direction === "min" ? `must be at least ${bound}` : `limited to ${bound}`;
}

function formatValue(field: keyof AgentGovernancePolicy, policy: AgentGovernancePolicy): string {
  switch (field) {
    case "permissions":
      return describeList(policy.permissions);
    case "dataScopes":
      return describeList(policy.dataScopes);
    case "providers":
      return describeList(policy.providers);
    case "monthlyBudgetCents":
      return describeBudget(policy.monthlyBudgetCents);
    case "destructiveActions":
      return policy.destructiveActions.replace(/_/g, " ");
    case "minimumApproval":
      return policy.minimumApproval;
  }
}

/**
 * Explains an agent's authority as three columns: what the owner permits, what
 * the steward asked for, and what is actually in force. Showing the ceiling
 * beside the effective value is the point — a steward needs to see WHY a
 * setting is capped, not just that it is.
 */
export function AgentGovernancePanel({
  policy,
  violations,
}: {
  policy: AgentGovernanceRecord;
  violations?: AgentPolicyViolation[];
}) {
  const fields = Object.keys(DIMENSION_LABELS) as Array<keyof AgentGovernancePolicy>;

  return (
    <section aria-labelledby="agent-governance-heading" className="rounded-lg border p-4">
      <h2 id="agent-governance-heading" className="text-sm font-semibold">
        Authority
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        In force is the owner ceiling intersected with your requested configuration.
      </p>

      {violations && violations.length > 0 ? (
        <div role="alert" className="mt-3 rounded border border-destructive/40 p-3 text-xs">
          <p className="font-medium">That change exceeds the owner ceiling.</p>
          <ul className="mt-1 list-disc pl-4">
            {violations.map((violation) => (
              <li key={violation.field}>
                {DIMENSION_LABELS[violation.field]}: {describeViolation(violation)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <table className="mt-3 w-full text-left text-xs">
        <thead>
          <tr className="text-muted-foreground">
            <th scope="col" className="py-1 font-medium">Dimension</th>
            <th scope="col" className="py-1 font-medium">Owner ceiling</th>
            <th scope="col" className="py-1 font-medium">Requested</th>
            <th scope="col" className="py-1 font-medium">In force</th>
          </tr>
        </thead>
        <tbody>
          {fields.map((field) => {
            const capped =
              formatValue(field, policy.effectivePolicy) !== formatValue(field, policy.stewardRequest);
            return (
              <tr key={field} className="border-t">
                <th scope="row" className="py-1 font-normal">{DIMENSION_LABELS[field]}</th>
                <td className="py-1">{formatValue(field, policy.ownerCeiling)}</td>
                <td className="py-1">{formatValue(field, policy.stewardRequest)}</td>
                <td className="py-1 font-medium">
                  {formatValue(field, policy.effectivePolicy)}
                  {capped ? (
                    <span className="ml-1 text-muted-foreground" title="Capped by the owner ceiling">
                      (capped)
                    </span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
