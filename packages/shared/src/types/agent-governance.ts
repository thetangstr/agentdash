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

export const AGENT_GOVERNANCE_CHANNELS = ["web", "telegram", "teams", "whatsapp", "system"] as const;
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

// ---------------------------------------------------------------------------
// AgentDash: Agent Performance Management gate 2 — access policy V2
// (doc/plans/2026-10-29-agent-access-lld.md §3).
//
// V2 extends the stored governance policy with optional see / do / talk
// dimensions. The six V1 fields above keep their meaning and their MK
// consumers (`resolveAgentPolicy`, the credential fallback, bridge approval
// selection, ceilings). V2 is evaluated by a separate, narrow-only function
// (`evaluateAccessV2` in `agent-access-v2.ts`): an omitted dimension means
// "not restricted by V2", and a V2 result can only take access away.
// ---------------------------------------------------------------------------

export const AGENT_ACCESS_POLICY_VERSION = 2 as const;

/**
 * Approval mode for a connection action class. Ordered most to least
 * restrictive: `never` < `approve` < `auto`. `auto` means only that THIS
 * policy adds no approval; it never removes one another rule requires
 * (access LLD §3.2 send precedence).
 */
export const AGENT_ACCESS_MODES = ["never", "approve", "auto"] as const;
export type AgentAccessMode = (typeof AGENT_ACCESS_MODES)[number];

export const AGENT_ACCESS_LIST_SCOPE_MODES = ["all", "listed"] as const;
export type AgentAccessListScopeMode = (typeof AGENT_ACCESS_LIST_SCOPE_MODES)[number];

/** `listed` with an empty `ids` list means nothing. `all` ignores `ids`. */
export interface AgentAccessListScope {
  mode: AgentAccessListScopeMode;
  ids: string[];
}

/**
 * Contact modes are predicates evaluated at check time, never flattened into
 * stored JSON (they cannot be ranked against each other):
 * - `any`: everyone;
 * - `listed`: the id is in `agentIds` / `userIds`;
 * - `reports_chain`: the agent's live `reportsTo` chain and its direct reports;
 * - `accountable_only`: the agent's accountable user, steward or company admins.
 */
export const AGENT_ACCESS_CONTACT_MODES = ["any", "listed", "reports_chain", "accountable_only"] as const;
export type AgentAccessContactMode = (typeof AGENT_ACCESS_CONTACT_MODES)[number];

export interface AgentAccessContactScope {
  mode: AgentAccessContactMode;
  agentIds?: string[];
  userIds?: string[];
}

/** The ways one agent reaches another (access LLD §4, the one wake-dispatch check). */
export const AGENT_ACCESS_CONTACT_VIAS = ["assign", "comment_wake", "mention", "handoff"] as const;
export type AgentAccessContactVia = (typeof AGENT_ACCESS_CONTACT_VIAS)[number];

export const AGENT_ACCESS_EXTERNAL_TARGET_MODES = ["listed", "domains", "any"] as const;
export type AgentAccessExternalTargetMode = (typeof AGENT_ACCESS_EXTERNAL_TARGET_MODES)[number];

export interface AgentAccessSee {
  /** Projects, their issues, comments, documents and attachments. Ids are project ids. */
  projects?: AgentAccessListScope;
  /** Connections it may read through, each limited to the listed data scopes (`["*"]` = every scope). */
  connections?: Array<{ connectionId: string; dataScopes: string[] }>;
}

export interface AgentAccessDo {
  /** Per-connection approval mode for drafts and sends. A connection not listed is `never`. */
  connections?: Array<{ connectionId: string; draft: AgentAccessMode; send: AgentAccessMode }>;
  /** Company skills (by skill key) it may run with, on every writer and at runtime. */
  skills?: AgentAccessListScope;
}

export interface AgentAccessTalk {
  /** Agents it may reach, and through which channels (`via` is intersected across ceiling and request). */
  agents?: AgentAccessContactScope & { via: AgentAccessContactVia[] };
  /** People it may route questions, approvals and bridge tasks to. The escalation path is always open. */
  people?: AgentAccessContactScope;
  /** External send targets per connection. A connection not listed admits no external target. */
  external?: Array<{
    connectionId: string;
    targets: { mode: AgentAccessExternalTargetMode; values: string[] };
  }>;
  /** Who may assign to, comment-wake or mention THIS agent. People with configuration authority are never blocked. */
  inbound?: AgentAccessContactScope;
}

/** The optional V2 dimensions. Omitted = not restricted by V2. */
export interface AgentAccessPolicyV2Fields {
  see?: AgentAccessSee;
  do?: AgentAccessDo;
  talk?: AgentAccessTalk;
}

/**
 * Access policy V2 (access LLD §3.1): the V1 governance policy plus optional
 * see / do / talk dimensions. This is the PARSED form — `parseAccessPolicy`
 * upgrades a stored V1 row on read, so `policyVersion` is always 2 here.
 */
export interface AgentAccessPolicy extends AgentGovernancePolicy, AgentAccessPolicyV2Fields {
  policyVersion: typeof AGENT_ACCESS_POLICY_VERSION;
}

/**
 * What an `agent_governance_policies` side (owner ceiling or steward request)
 * may hold in its jsonb: a V1 row, or a V2 row. A row carries `policyVersion`
 * and V2 dimensions only once some V2 dimension has been written, so MK V1
 * rows stay byte-identical (`mergeAccessPolicyWrite`: V1 in, V1 out).
 */
export type StoredAgentGovernancePolicy = AgentGovernancePolicy &
  AgentAccessPolicyV2Fields & { policyVersion?: typeof AGENT_ACCESS_POLICY_VERSION };

/** Every V2 dimension, addressed as `<section>.<field>`. The unit of merge, clear and refusal. */
export const AGENT_ACCESS_V2_DIMENSIONS = [
  "see.projects",
  "see.connections",
  "do.connections",
  "do.skills",
  "talk.agents",
  "talk.people",
  "talk.external",
  "talk.inbound",
] as const;
export type AgentAccessV2Dimension = (typeof AGENT_ACCESS_V2_DIMENSIONS)[number];
