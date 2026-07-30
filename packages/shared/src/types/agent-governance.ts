// AgentDash-MK: owner ceilings and steward-requested agent configuration.
//
// The effective agent policy is always `owner ceiling ∩ steward request`.
// Everything in this module is pure and deterministic so the same intersection
// can be reused by API mutations, runtime authorization, and the UI without
// any risk of the three disagreeing.

export const AGENT_DESTRUCTIVE_ACTION_MODES = ["blocked", "approval_required", "allowed"] as const;
export type AgentDestructiveActionMode = (typeof AGENT_DESTRUCTIVE_ACTION_MODES)[number];

export const AGENT_MINIMUM_APPROVAL_MODES = ["none", "steward"] as const;
export type AgentMinimumApprovalMode = (typeof AGENT_MINIMUM_APPROVAL_MODES)[number];

export const AGENT_GOVERNANCE_CHANNELS = ["web", "telegram", "teams", "system"] as const;
export type AgentGovernanceChannel = (typeof AGENT_GOVERNANCE_CHANNELS)[number];

/**
 * Wildcard entry for a list-valued ceiling dimension. A ceiling of `["*"]`
 * places no restriction on that dimension; a request of `["*"]` asks for
 * "whatever the ceiling allows".
 */
export const AGENT_POLICY_WILDCARD = "*";

/**
 * Postgres `integer` maximum, used as the "no budget ceiling" sentinel so the
 * unrestricted default still round-trips through an integer column.
 */
export const AGENT_POLICY_UNLIMITED_BUDGET_CENTS = 2_147_483_647;

export interface AgentGovernancePolicy {
  permissions: string[];
  monthlyBudgetCents: number;
  destructiveActions: AgentDestructiveActionMode;
  dataScopes: string[];
  providers: string[];
  minimumApproval: AgentMinimumApprovalMode;
}

/**
 * Default ceiling. The three enumerable dimensions (`permissions`,
 * `dataScopes`, `providers`) and the budget are deliberately unrestricted so
 * enabling the `agentdash_mk` profile cannot, by itself, take authority away
 * from an existing agent — owners tighten those explicitly.
 *
 * `destructiveActions` and `minimumApproval` are NOT unrestricted: they default
 * to the safe end of their orderings, matching the profile's premise that
 * destructive work is approved and that approval authority belongs to the
 * steward. They are inert until Task 4 gives them a runtime consumer, but the
 * default is chosen so switching them on later tightens nothing retroactively.
 */
export const DEFAULT_AGENT_GOVERNANCE_POLICY: AgentGovernancePolicy = Object.freeze({
  permissions: [AGENT_POLICY_WILDCARD],
  monthlyBudgetCents: AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
  destructiveActions: "approval_required",
  dataScopes: [AGENT_POLICY_WILDCARD],
  providers: [AGENT_POLICY_WILDCARD],
  minimumApproval: "steward",
}) as AgentGovernancePolicy;

export const AGENT_POLICY_VIOLATION_CODES = [
  "PERMISSION_NOT_ALLOWED",
  "BUDGET_EXCEEDS_CEILING",
  "DESTRUCTIVE_ACTIONS_EXCEED_CEILING",
  "DATA_SCOPE_NOT_ALLOWED",
  "PROVIDER_NOT_ALLOWED",
  "MINIMUM_APPROVAL_BELOW_CEILING",
] as const;
export type AgentPolicyViolationCode = (typeof AGENT_POLICY_VIOLATION_CODES)[number];

export interface AgentPolicyViolation {
  field: keyof AgentGovernancePolicy;
  code: AgentPolicyViolationCode;
  requested: string[] | string | number;
  /**
   * The bound that was breached. `direction` says how to read it: `"max"` means
   * `allowed` is a maximum the request exceeded, `"min"` means it is a floor the
   * request fell below (`minimumApproval` is the only floor). Without this a UI
   * rendering "allowed: X" uniformly would invert the meaning of that one field.
   */
  allowed: string[] | string | number;
  direction: "max" | "min";
}

export const AGENT_POLICY_CEILING_EXCEEDED = "AGENT_POLICY_CEILING_EXCEEDED";
export const AGENT_POLICY_REVISION_CONFLICT = "AGENT_POLICY_REVISION_CONFLICT";

/**
 * Thrown by `assertWithinCeiling`. Carries a stable machine-readable code plus
 * the full violation list. It names only policy dimensions and the values the
 * caller already supplied, so it never leaks secrets.
 */
export class AgentPolicyCeilingError extends Error {
  readonly code = AGENT_POLICY_CEILING_EXCEEDED;
  readonly violations: AgentPolicyViolation[];

  constructor(violations: AgentPolicyViolation[]) {
    super(
      `Requested agent configuration exceeds the owner ceiling: ${violations
        .map((violation) => violation.field)
        .join(", ")}`,
    );
    this.name = "AgentPolicyCeilingError";
    this.violations = violations;
  }
}

const DESTRUCTIVE_RANK: Record<AgentDestructiveActionMode, number> = {
  blocked: 0,
  approval_required: 1,
  allowed: 2,
};

const APPROVAL_RANK: Record<AgentMinimumApprovalMode, number> = {
  none: 0,
  steward: 1,
};

function normalizeList(values: readonly string[]): string[] {
  const cleaned = values.map((value) => value.trim()).filter((value) => value.length > 0);
  if (cleaned.includes(AGENT_POLICY_WILDCARD)) return [AGENT_POLICY_WILDCARD];
  return [...new Set(cleaned)].sort();
}

function isUnrestricted(values: readonly string[]): boolean {
  return values.includes(AGENT_POLICY_WILDCARD);
}

function intersectList(ceiling: readonly string[], requested: readonly string[]): string[] {
  const normalizedCeiling = normalizeList(ceiling);
  const normalizedRequest = normalizeList(requested);
  if (isUnrestricted(normalizedCeiling) && isUnrestricted(normalizedRequest)) {
    return [AGENT_POLICY_WILDCARD];
  }
  // A wildcard ceiling defers entirely to the request; a wildcard request
  // accepts exactly what the ceiling allows.
  if (isUnrestricted(normalizedCeiling)) return normalizedRequest;
  if (isUnrestricted(normalizedRequest)) return normalizedCeiling;
  const allowed = new Set(normalizedCeiling);
  return normalizedRequest.filter((value) => allowed.has(value));
}

function listOverflow(ceiling: readonly string[], requested: readonly string[]): string[] {
  const normalizedCeiling = normalizeList(ceiling);
  if (isUnrestricted(normalizedCeiling)) return [];
  const normalizedRequest = normalizeList(requested);
  // A wildcard request is a request for "whatever is allowed", never an overflow.
  if (isUnrestricted(normalizedRequest)) return [];
  const allowed = new Set(normalizedCeiling);
  return normalizedRequest.filter((value) => !allowed.has(value));
}

/**
 * Compute `owner ceiling ∩ steward request`.
 *
 * Clamping, never throwing: each dimension is reduced to the more restrictive
 * of the two. `minimumApproval` is the exception in direction — the ceiling
 * sets a *floor*, so the effective value is the stricter (higher) of the two.
 */
export function computeEffectiveAgentPolicy(
  ceiling: AgentGovernancePolicy,
  requested: AgentGovernancePolicy,
): AgentGovernancePolicy {
  return {
    permissions: intersectList(ceiling.permissions, requested.permissions),
    monthlyBudgetCents: Math.min(ceiling.monthlyBudgetCents, requested.monthlyBudgetCents),
    destructiveActions:
      DESTRUCTIVE_RANK[requested.destructiveActions] <= DESTRUCTIVE_RANK[ceiling.destructiveActions]
        ? requested.destructiveActions
        : ceiling.destructiveActions,
    dataScopes: intersectList(ceiling.dataScopes, requested.dataScopes),
    providers: intersectList(ceiling.providers, requested.providers),
    minimumApproval:
      APPROVAL_RANK[requested.minimumApproval] >= APPROVAL_RANK[ceiling.minimumApproval]
        ? requested.minimumApproval
        : ceiling.minimumApproval,
  };
}

/**
 * Collect every way `requested` reaches beyond `ceiling`. Order is stable and
 * follows the declaration order of `AgentGovernancePolicy` so callers and tests
 * can rely on it.
 */
export function collectCeilingViolations(
  ceiling: AgentGovernancePolicy,
  requested: AgentGovernancePolicy,
): AgentPolicyViolation[] {
  const violations: AgentPolicyViolation[] = [];

  const permissionOverflow = listOverflow(ceiling.permissions, requested.permissions);
  if (permissionOverflow.length > 0) {
    violations.push({
      field: "permissions",
      code: "PERMISSION_NOT_ALLOWED",
      requested: permissionOverflow,
      allowed: normalizeList(ceiling.permissions),
      direction: "max",
    });
  }

  if (requested.monthlyBudgetCents > ceiling.monthlyBudgetCents) {
    violations.push({
      field: "monthlyBudgetCents",
      code: "BUDGET_EXCEEDS_CEILING",
      requested: requested.monthlyBudgetCents,
      allowed: ceiling.monthlyBudgetCents,
      direction: "max",
    });
  }

  if (DESTRUCTIVE_RANK[requested.destructiveActions] > DESTRUCTIVE_RANK[ceiling.destructiveActions]) {
    violations.push({
      field: "destructiveActions",
      code: "DESTRUCTIVE_ACTIONS_EXCEED_CEILING",
      requested: requested.destructiveActions,
      allowed: ceiling.destructiveActions,
      direction: "max",
    });
  }

  const dataScopeOverflow = listOverflow(ceiling.dataScopes, requested.dataScopes);
  if (dataScopeOverflow.length > 0) {
    violations.push({
      field: "dataScopes",
      code: "DATA_SCOPE_NOT_ALLOWED",
      requested: dataScopeOverflow,
      allowed: normalizeList(ceiling.dataScopes),
      direction: "max",
    });
  }

  const providerOverflow = listOverflow(ceiling.providers, requested.providers);
  if (providerOverflow.length > 0) {
    violations.push({
      field: "providers",
      code: "PROVIDER_NOT_ALLOWED",
      requested: providerOverflow,
      allowed: normalizeList(ceiling.providers),
      direction: "max",
    });
  }

  if (APPROVAL_RANK[requested.minimumApproval] < APPROVAL_RANK[ceiling.minimumApproval]) {
    violations.push({
      field: "minimumApproval",
      code: "MINIMUM_APPROVAL_BELOW_CEILING",
      requested: requested.minimumApproval,
      allowed: ceiling.minimumApproval,
      // The ceiling is a FLOOR here: the request asked for weaker approval.
      direction: "min",
    });
  }

  return violations;
}

/** Throw `AgentPolicyCeilingError` when `requested` exceeds `ceiling`. */
export function assertWithinCeiling(
  ceiling: AgentGovernancePolicy,
  requested: AgentGovernancePolicy,
): void {
  const violations = collectCeilingViolations(ceiling, requested);
  if (violations.length > 0) {
    throw new AgentPolicyCeilingError(violations);
  }
}

/**
 * Does a list-valued ceiling dimension admit `value`?
 *
 * Runtime enforcement points (connector resolution, channel binding) need the
 * same membership rule the mutation path uses, and they need it without
 * constructing a whole candidate policy. Sharing this function is what keeps
 * "what the ceiling permits" from meaning one thing at write time and another
 * at use time.
 */
export function policyListAllows(allowed: readonly string[], value: string): boolean {
  const normalized = normalizeList(allowed);
  if (isUnrestricted(normalized)) return true;
  return normalized.includes(value.trim());
}

/** Every value must be admitted. An empty `values` is vacuously allowed. */
export function policyListAllowsAll(allowed: readonly string[], values: readonly string[]): boolean {
  const normalized = normalizeList(allowed);
  if (isUnrestricted(normalized)) return true;
  return values.every((value) => normalized.includes(value.trim()));
}

/** Normalize a policy into its canonical (sorted, deduplicated) form. */
export function normalizeAgentGovernancePolicy(policy: AgentGovernancePolicy): AgentGovernancePolicy {
  return {
    permissions: normalizeList(policy.permissions),
    monthlyBudgetCents: policy.monthlyBudgetCents,
    destructiveActions: policy.destructiveActions,
    dataScopes: normalizeList(policy.dataScopes),
    providers: normalizeList(policy.providers),
    minimumApproval: policy.minimumApproval,
  };
}

export interface AgentGovernancePolicyRecord {
  id: string;
  companyId: string;
  agentId: string;
  ownerCeiling: AgentGovernancePolicy;
  ownerCeilingRevision: number;
  ownerCeilingUpdatedByUserId: string | null;
  stewardRequest: AgentGovernancePolicy;
  stewardRequestRevision: number;
  stewardRequestUpdatedByUserId: string | null;
  effectivePolicy: AgentGovernancePolicy;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Which side of the policy a mutation targets — used for audit attribution. */
export const AGENT_GOVERNANCE_TARGETS = ["owner_ceiling", "steward_request"] as const;
export type AgentGovernanceTarget = (typeof AGENT_GOVERNANCE_TARGETS)[number];
