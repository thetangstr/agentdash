import {
  AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
  AGENT_POLICY_WILDCARD,
  type AgentGovernancePolicy,
} from "@paperclipai/shared";

/**
 * The authority policy, in sentences a person can read.
 *
 * The mandate itself is a markdown file edited in a textarea — the right
 * instrument for whoever writes it, and the wrong one for the steward who only
 * needs to know what their agent may do. The policy beside it is structured
 * (`permissions`, `monthlyBudgetCents`, `destructiveActions`, `dataScopes`,
 * `providers`, `minimumApproval`), so it can be said in words instead.
 *
 * Every line is derived, never guessed: an unrecognised value falls through to
 * naming the raw value rather than inventing a reassuring sentence, because the
 * one thing worse than jargon here is a comforting sentence that is wrong.
 */
export function describeAuthority(policy: AgentGovernancePolicy | null | undefined): string[] {
  if (!policy) return [];
  const lines: string[] = [];

  // Spending. The sentinel is Postgres' integer max, not a real budget.
  if (policy.monthlyBudgetCents >= AGENT_POLICY_UNLIMITED_BUDGET_CENTS) {
    lines.push("No spending limit has been set.");
  } else {
    const dollars = policy.monthlyBudgetCents / 100;
    const shown = Number.isInteger(dollars) ? dollars.toLocaleString() : dollars.toFixed(2);
    lines.push(`Can spend up to $${shown} a month.`);
  }

  switch (policy.destructiveActions) {
    case "blocked":
      lines.push("Cannot delete or undo anything, even if asked.");
      break;
    case "approval_required":
      lines.push("Must get your approval before deleting anything or doing something it cannot undo.");
      break;
    case "allowed":
      lines.push("May delete things and take actions it cannot undo without asking first.");
      break;
    default:
      lines.push(`Destructive actions: ${String(policy.destructiveActions)}.`);
  }

  switch (policy.minimumApproval) {
    case "steward":
      lines.push("You are the one who approves its requests.");
      break;
    case "none":
      lines.push("No particular person is required to approve its requests.");
      break;
    default:
      lines.push(`Approvals: ${String(policy.minimumApproval)}.`);
  }

  const wide = (list: string[]) => list.length === 0 || list.includes(AGENT_POLICY_WILDCARD);
  if (!wide(policy.permissions)) {
    lines.push(`Limited to ${policy.permissions.length} specific permission(s).`);
  }
  if (!wide(policy.dataScopes)) {
    lines.push(`Can only reach ${policy.dataScopes.length} area(s) of your data.`);
  }
  if (!wide(policy.providers)) {
    lines.push(`Restricted to ${policy.providers.length} named provider(s).`);
  }

  return lines;
}

/** True when nothing has been narrowed — worth saying plainly rather than listing nothing. */
export function isUnrestricted(policy: AgentGovernancePolicy | null | undefined): boolean {
  if (!policy) return false;
  const wide = (list: string[]) => list.length === 0 || list.includes(AGENT_POLICY_WILDCARD);
  return (
    policy.monthlyBudgetCents >= AGENT_POLICY_UNLIMITED_BUDGET_CENTS &&
    policy.destructiveActions === "allowed" &&
    policy.minimumApproval === "none" &&
    wide(policy.permissions) &&
    wide(policy.dataScopes) &&
    wide(policy.providers)
  );
}
