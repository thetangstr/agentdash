import {
  AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
  AGENT_POLICY_WILDCARD,
  type AgentDestructiveActionMode,
  type AgentGovernancePolicy,
  type AgentMinimumApprovalMode,
} from "./types/agent-governance.js";

/**
 * AgentDash admin powers: what an agent gains and loses when its effective
 * policy changes from `before` to `after`, in plain words, per field. Pure, so
 * the server's batch preview and the UI read the same answer.
 *
 * Direction: more budget, more permissions/data/providers, a looser
 * destructive-action rule and a lower minimum approval are gains; the reverse
 * are losses.
 */

export type GovernanceDiffField =
  | "monthlyBudgetCents"
  | "permissions"
  | "dataScopes"
  | "providers"
  | "destructiveActions"
  | "minimumApproval";

export interface GovernanceChange {
  field: GovernanceDiffField;
  /** "Budget: up to $500 a month (was no limit)" */
  text: string;
}

export interface GovernanceDiff {
  gains: GovernanceChange[];
  losses: GovernanceChange[];
}

const FIELD_LABELS: Record<GovernanceDiffField, string> = {
  monthlyBudgetCents: "Budget",
  permissions: "Permissions",
  dataScopes: "Data",
  providers: "Providers",
  destructiveActions: "Actions that cannot be undone",
  minimumApproval: "Approval",
};

const DESTRUCTIVE_RANK: Record<AgentDestructiveActionMode, number> = { blocked: 0, approval_required: 1, allowed: 2 };
const DESTRUCTIVE_WORDS: Record<AgentDestructiveActionMode, string> = {
  blocked: "never",
  approval_required: "only with approval",
  allowed: "allowed",
};
const APPROVAL_RANK: Record<AgentMinimumApprovalMode, number> = { none: 0, steward: 1 };
const APPROVAL_WORDS: Record<AgentMinimumApprovalMode, string> = { none: "no approval needed", steward: "its steward approves" };

function list(values: readonly string[] | undefined): string[] | "any" {
  const cleaned = (values ?? []).map((value) => value.trim()).filter(Boolean);
  if (cleaned.includes(AGENT_POLICY_WILDCARD)) return "any";
  return [...new Set(cleaned)].sort();
}

function listWords(values: string[] | "any"): string {
  if (values === "any") return "any";
  return values.length === 0 ? "none" : values.join(", ");
}

function budgetWords(cents: number): string {
  if (cents >= AGENT_POLICY_UNLIMITED_BUDGET_CENTS) return "no limit";
  const dollars = cents / 100;
  return `up to $${Number.isInteger(dollars) ? dollars.toLocaleString("en-US") : dollars.toFixed(2)} a month`;
}

export function diffGovernancePolicies(before: AgentGovernancePolicy, after: AgentGovernancePolicy): GovernanceDiff {
  const gains: GovernanceChange[] = [];
  const losses: GovernanceChange[] = [];
  const push = (into: GovernanceChange[], field: GovernanceDiffField, text: string) => into.push({ field, text: `${FIELD_LABELS[field]}: ${text}` });

  if (after.monthlyBudgetCents !== before.monthlyBudgetCents) {
    push(after.monthlyBudgetCents > before.monthlyBudgetCents ? gains : losses, "monthlyBudgetCents",
      `${budgetWords(after.monthlyBudgetCents)} (was ${budgetWords(before.monthlyBudgetCents)})`);
  }

  for (const field of ["permissions", "dataScopes", "providers"] as const) {
    const from = list(before[field]);
    const to = list(after[field]);
    if (from === "any" && to === "any") continue;
    if (from === "any") {
      push(losses, field, `only ${listWords(to)} (was any)`);
      continue;
    }
    if (to === "any") {
      push(gains, field, `any (was ${listWords(from)})`);
      continue;
    }
    const added = to.filter((value) => !from.includes(value));
    const removed = from.filter((value) => !to.includes(value));
    if (added.length > 0) push(gains, field, `adds ${added.join(", ")}`);
    if (removed.length > 0) push(losses, field, `loses ${removed.join(", ")}`);
  }

  if (after.destructiveActions !== before.destructiveActions) {
    push(DESTRUCTIVE_RANK[after.destructiveActions] > DESTRUCTIVE_RANK[before.destructiveActions] ? gains : losses,
      "destructiveActions", `${DESTRUCTIVE_WORDS[after.destructiveActions]} (was ${DESTRUCTIVE_WORDS[before.destructiveActions]})`);
  }

  if (after.minimumApproval !== before.minimumApproval) {
    push(APPROVAL_RANK[after.minimumApproval] < APPROVAL_RANK[before.minimumApproval] ? gains : losses,
      "minimumApproval", `${APPROVAL_WORDS[after.minimumApproval]} (was ${APPROVAL_WORDS[before.minimumApproval]})`);
  }

  return { gains, losses };
}
