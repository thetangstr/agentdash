import type { AgentGovernancePolicy, AgentPolicyViolation } from "@paperclipai/shared";
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
  if (cents >= 2_147_483_647) return "Unrestricted";
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}/mo`;
}

const DIMENSION_LABELS: Record<keyof AgentGovernancePolicy, string> = {
  permissions: "Permissions",
  monthlyBudgetCents: "Monthly budget",
  destructiveActions: "Destructive actions",
  dataScopes: "Data scopes",
  providers: "Providers",
  minimumApproval: "Minimum approval",
};

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
  const violationsByField = new Map(violations?.map((v) => [v.field, v]));

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
                {DIMENSION_LABELS[violation.field]}:{" "}
                {violation.direction === "min"
                  ? `must be at least ${String(violation.allowed)}`
                  : `limited to ${
                      Array.isArray(violation.allowed)
                        ? describeList(violation.allowed)
                        : String(violation.allowed)
                    }`}
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
                  {violationsByField.has(field) ? null : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
