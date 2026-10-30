import { z } from "zod";
import {
  AGENT_ACCESS_CONTACT_MODES,
  AGENT_ACCESS_CONTACT_VIAS,
  AGENT_ACCESS_EXTERNAL_TARGET_MODES,
  AGENT_ACCESS_LIST_SCOPE_MODES,
  AGENT_ACCESS_MODES,
  AGENT_ACCESS_POLICY_VERSION,
  AGENT_ACCESS_V2_DIMENSIONS,
  AGENT_DESTRUCTIVE_ACTION_MODES,
  AGENT_MINIMUM_APPROVAL_MODES,
  AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
  AGENT_POLICY_WILDCARD,
  normalizeAgentGovernancePolicy,
  policyListAllows,
  type AgentAccessContactScope,
  type AgentAccessContactVia,
  type AgentAccessDo,
  type AgentAccessListScope,
  type AgentAccessMode,
  type AgentAccessPolicy,
  type AgentAccessPolicyV2Fields,
  type AgentAccessSee,
  type AgentAccessTalk,
  type AgentAccessV2Dimension,
  type AgentDestructiveActionMode,
  type AgentGovernancePolicy,
  type StoredAgentGovernancePolicy,
} from "./types/agent-governance.js";
import { agentGovernancePolicySchema } from "./validators/agent-governance.js";

/**
 * AgentDash: Agent Performance Management gate 2 — access policy V2, pure.
 *
 * Design: doc/plans/2026-10-29-agent-access-lld.md §3 (shape, combination,
 * send precedence, merge) and §4 (the matrix rows that call `evaluateAccessV2`
 * through the server's `checkAgentAccess`).
 *
 * Three rules hold for everything in this module:
 * 1. **Narrow only.** `evaluateAccessV2` can refuse what the legacy path allows;
 *    it never allows what the legacy path refuses and never switches on an
 *    MK-only behaviour. An omitted dimension means "not restricted by V2".
 * 2. **Separate from V1.** `resolveAgentPolicy` and `computeEffectiveAgentPolicy`
 *    keep their MK meaning. V2 dimensions are never flattened into the stored
 *    effective policy; ceiling and request are evaluated side by side at check
 *    time (contact scopes are predicates over live data).
 * 3. **No silent loss.** A V1-shaped write keeps the stored V2 dimensions;
 *    clearing a V2 dimension requires naming it (access LLD §3.4).
 */

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const scopeIdSchema = z.string().trim().min(1).max(200);
const agentIdListSchema = z.array(z.string().uuid()).max(500);
const userIdListSchema = z.array(scopeIdSchema).max(500);

export const agentAccessListScopeSchema = z
  .object({
    mode: z.enum(AGENT_ACCESS_LIST_SCOPE_MODES),
    ids: z.array(scopeIdSchema).max(1000),
  })
  .strict();

export const agentAccessContactScopeSchema = z
  .object({
    mode: z.enum(AGENT_ACCESS_CONTACT_MODES),
    agentIds: agentIdListSchema.optional(),
    userIds: userIdListSchema.optional(),
  })
  .strict();

function uniqueBy<T>(key: (item: T) => string) {
  return (items: T[]) => new Set(items.map(key)).size === items.length;
}

const dataScopeListSchema = z
  .array(scopeIdSchema)
  .max(200)
  .refine((values) => !values.includes(AGENT_POLICY_WILDCARD) || values.length === 1, {
    message: `"${AGENT_POLICY_WILDCARD}" cannot be combined with specific data scopes`,
  });

export const agentAccessSeeSchema = z
  .object({
    projects: agentAccessListScopeSchema.optional(),
    connections: z
      .array(z.object({ connectionId: z.string().uuid(), dataScopes: dataScopeListSchema }).strict())
      .max(200)
      .refine(uniqueBy((entry) => entry.connectionId), { message: "each connection may appear once" })
      .optional(),
  })
  .strict();

export const agentAccessDoSchema = z
  .object({
    connections: z
      .array(
        z
          .object({
            connectionId: z.string().uuid(),
            draft: z.enum(AGENT_ACCESS_MODES),
            send: z.enum(AGENT_ACCESS_MODES),
          })
          .strict(),
      )
      .max(200)
      .refine(uniqueBy((entry) => entry.connectionId), { message: "each connection may appear once" })
      .optional(),
    skills: agentAccessListScopeSchema.optional(),
  })
  .strict();

export const agentAccessTalkSchema = z
  .object({
    agents: agentAccessContactScopeSchema
      .extend({ via: z.array(z.enum(AGENT_ACCESS_CONTACT_VIAS)).max(AGENT_ACCESS_CONTACT_VIAS.length) })
      .strict()
      .optional(),
    people: agentAccessContactScopeSchema.optional(),
    external: z
      .array(
        z
          .object({
            connectionId: z.string().uuid(),
            targets: z
              .object({
                mode: z.enum(AGENT_ACCESS_EXTERNAL_TARGET_MODES),
                values: z.array(z.string().trim().min(1).max(320)).max(500),
              })
              .strict(),
          })
          .strict(),
      )
      .max(200)
      .refine(uniqueBy((entry) => entry.connectionId), { message: "each connection may appear once" })
      .optional(),
    inbound: agentAccessContactScopeSchema.optional(),
  })
  .strict();

/**
 * An authored V2 policy — what an operating profile's `access` section holds
 * (the request side). Strict like the V1 schema it extends: an unknown key is
 * a mistake to reject, not a field to keep.
 */
export const agentAccessPolicySchema = agentGovernancePolicySchema
  .extend({
    policyVersion: z.literal(AGENT_ACCESS_POLICY_VERSION),
    see: agentAccessSeeSchema.optional(),
    do: agentAccessDoSchema.optional(),
    talk: agentAccessTalkSchema.optional(),
  })
  .strict();

export type AgentAccessPolicyInput = z.infer<typeof agentAccessPolicySchema>;

/**
 * What a stored governance side may hold. Lenient on purpose: stored V1 rows
 * were normalized by today's writers (and may predate the strict list rules),
 * and an unknown key from a future version is dropped rather than failing a
 * runtime check. The V2 dimensions themselves are still validated.
 */
const storedAgentGovernancePolicySchema = z.object({
  permissions: z.array(z.string()),
  monthlyBudgetCents: z.number().int().nonnegative().max(AGENT_POLICY_UNLIMITED_BUDGET_CENTS),
  destructiveActions: z.enum(AGENT_DESTRUCTIVE_ACTION_MODES),
  dataScopes: z.array(z.string()),
  providers: z.array(z.string()),
  minimumApproval: z.enum(AGENT_MINIMUM_APPROVAL_MODES),
  policyVersion: z.literal(AGENT_ACCESS_POLICY_VERSION).optional(),
  see: agentAccessSeeSchema.optional(),
  do: agentAccessDoSchema.optional(),
  talk: agentAccessTalkSchema.optional(),
});

export const AGENT_ACCESS_POLICY_INVALID = "AGENT_ACCESS_POLICY_INVALID";
export const AGENT_ACCESS_POLICY_WRITE_CONFLICT = "AGENT_ACCESS_POLICY_WRITE_CONFLICT";

/** A stored governance side that is neither a V1 nor a V2 policy. Names only zod paths, never values. */
export class AgentAccessPolicyParseError extends Error {
  readonly code = AGENT_ACCESS_POLICY_INVALID;
  readonly issues: Array<{ path: string; message: string }>;

  constructor(issues: Array<{ path: string; message: string }>) {
    super(`Stored access policy is invalid: ${issues.map((issue) => issue.path || "(root)").join(", ")}`);
    this.name = "AgentAccessPolicyParseError";
    this.issues = issues;
  }
}

/** A write that both supplies a V2 dimension and names it in `clear`. */
export class AgentAccessPolicyWriteError extends Error {
  readonly code = AGENT_ACCESS_POLICY_WRITE_CONFLICT;
  readonly dimensions: AgentAccessV2Dimension[];

  constructor(dimensions: AgentAccessV2Dimension[]) {
    super(`An access policy write both sets and clears: ${dimensions.join(", ")}`);
    this.name = "AgentAccessPolicyWriteError";
    this.dimensions = dimensions;
  }
}

// ---------------------------------------------------------------------------
// Normalization and dimension access
// ---------------------------------------------------------------------------

const MODE_RANK: Record<AgentAccessMode, number> = { never: 0, approve: 1, auto: 2 };

function sortedUnique(values: readonly string[], transform: (value: string) => string = (value) => value.trim()): string[] {
  return [...new Set(values.map(transform).filter((value) => value.length > 0))].sort();
}

function normalizeWildcardList(values: readonly string[]): string[] {
  const cleaned = sortedUnique(values);
  return cleaned.includes(AGENT_POLICY_WILDCARD) ? [AGENT_POLICY_WILDCARD] : cleaned;
}

function stricterMode(a: AgentAccessMode, b: AgentAccessMode): AgentAccessMode {
  return MODE_RANK[a] <= MODE_RANK[b] ? a : b;
}

function normalizeListScope(scope: AgentAccessListScope): AgentAccessListScope {
  return scope.mode === "all" ? { mode: "all", ids: [] } : { mode: "listed", ids: sortedUnique(scope.ids) };
}

function normalizeContactScope(scope: AgentAccessContactScope): AgentAccessContactScope {
  // The id lists only mean something for `listed`; other modes are predicates.
  if (scope.mode !== "listed") return { mode: scope.mode };
  return {
    mode: "listed",
    agentIds: sortedUnique(scope.agentIds ?? []),
    userIds: sortedUnique(scope.userIds ?? []),
  };
}

function normalizeVia(via: readonly AgentAccessContactVia[]): AgentAccessContactVia[] {
  const wanted = new Set(via);
  return AGENT_ACCESS_CONTACT_VIAS.filter((value) => wanted.has(value));
}

function normalizeExternalValue(value: string): string {
  return value.trim().toLowerCase();
}

function byConnectionId<T extends { connectionId: string }>(a: T, b: T): number {
  return a.connectionId < b.connectionId ? -1 : a.connectionId > b.connectionId ? 1 : 0;
}

function normalizeSee(see: AgentAccessSee): AgentAccessSee {
  const out: AgentAccessSee = {};
  if (see.projects) out.projects = normalizeListScope(see.projects);
  if (see.connections) {
    // A duplicate connection (only possible in a hand-edited row) keeps the
    // narrower reading: the intersection of its data scopes.
    const merged = new Map<string, string[]>();
    for (const entry of see.connections) {
      const scopes = normalizeWildcardList(entry.dataScopes);
      const prior = merged.get(entry.connectionId);
      merged.set(entry.connectionId, prior ? intersectWildcardLists(prior, scopes) : scopes);
    }
    out.connections = [...merged.entries()]
      .map(([connectionId, dataScopes]) => ({ connectionId, dataScopes }))
      .sort(byConnectionId);
  }
  return out;
}

function intersectWildcardLists(a: string[], b: string[]): string[] {
  if (a.includes(AGENT_POLICY_WILDCARD)) return b;
  if (b.includes(AGENT_POLICY_WILDCARD)) return a;
  const allowed = new Set(a);
  return b.filter((value) => allowed.has(value));
}

function normalizeDo(value: AgentAccessDo): AgentAccessDo {
  const out: AgentAccessDo = {};
  if (value.connections) {
    const merged = new Map<string, { draft: AgentAccessMode; send: AgentAccessMode }>();
    for (const entry of value.connections) {
      const prior = merged.get(entry.connectionId);
      merged.set(
        entry.connectionId,
        prior
          ? { draft: stricterMode(prior.draft, entry.draft), send: stricterMode(prior.send, entry.send) }
          : { draft: entry.draft, send: entry.send },
      );
    }
    out.connections = [...merged.entries()]
      .map(([connectionId, modes]) => ({ connectionId, ...modes }))
      .sort(byConnectionId);
  }
  if (value.skills) out.skills = normalizeListScope(value.skills);
  return out;
}

function normalizeTalk(talk: AgentAccessTalk): AgentAccessTalk {
  const out: AgentAccessTalk = {};
  if (talk.agents) out.agents = { ...normalizeContactScope(talk.agents), via: normalizeVia(talk.agents.via) };
  if (talk.people) out.people = normalizeContactScope(talk.people);
  if (talk.external) {
    const merged = new Map<string, { mode: "listed" | "domains" | "any"; values: string[] }>();
    for (const entry of talk.external) {
      // Duplicates only come from hand-edited rows; the first entry wins and
      // the rest are dropped, which can only narrow.
      if (merged.has(entry.connectionId)) continue;
      merged.set(entry.connectionId, {
        mode: entry.targets.mode,
        values: entry.targets.mode === "any" ? [] : sortedUnique(entry.targets.values, normalizeExternalValue),
      });
    }
    out.external = [...merged.entries()]
      .map(([connectionId, targets]) => ({ connectionId, targets }))
      .sort(byConnectionId);
  }
  if (talk.inbound) out.inbound = normalizeContactScope(talk.inbound);
  return out;
}

type DimensionValue = NonNullable<
  | AgentAccessSee["projects"]
  | AgentAccessSee["connections"]
  | AgentAccessDo["connections"]
  | AgentAccessDo["skills"]
  | AgentAccessTalk["agents"]
  | AgentAccessTalk["people"]
  | AgentAccessTalk["external"]
  | AgentAccessTalk["inbound"]
>;

function getDimension(policy: AgentAccessPolicySideInput, dimension: AgentAccessV2Dimension): DimensionValue | undefined {
  if (!policy) return undefined;
  const [section, field] = dimension.split(".") as ["see" | "do" | "talk", string];
  const container = policy[section] as Record<string, DimensionValue | undefined> | undefined;
  return container?.[field] ?? undefined;
}

function setDimension(target: AgentAccessPolicyV2Fields, dimension: AgentAccessV2Dimension, value: DimensionValue): void {
  const [section, field] = dimension.split(".") as ["see" | "do" | "talk", string];
  const container = (target[section] ?? {}) as Record<string, DimensionValue>;
  container[field] = value;
  (target as Record<string, unknown>)[section] = container;
}

function normalizeV2Fields(policy: AgentAccessPolicyV2Fields | StoredAgentGovernancePolicy): AgentAccessPolicyV2Fields {
  const out: AgentAccessPolicyV2Fields = {};
  if (policy.see) {
    const see = normalizeSee(policy.see);
    if (Object.keys(see).length > 0) out.see = see;
  }
  if (policy.do) {
    const value = normalizeDo(policy.do);
    if (Object.keys(value).length > 0) out.do = value;
  }
  if (policy.talk) {
    const talk = normalizeTalk(policy.talk);
    if (Object.keys(talk).length > 0) out.talk = talk;
  }
  return out;
}

/**
 * One governance side as a V2 evaluator input: a parsed V2 policy, a stored
 * row (V1 or V2), or just the V2 dimensions. A V1 row restricts nothing in V2.
 */
export type AgentAccessPolicySideInput = AgentAccessPolicyV2Fields | StoredAgentGovernancePolicy | null | undefined;

/** The V2 dimensions a policy defines, in `AGENT_ACCESS_V2_DIMENSIONS` order. */
export function definedAccessV2Dimensions(policy: AgentAccessPolicySideInput): AgentAccessV2Dimension[] {
  return AGENT_ACCESS_V2_DIMENSIONS.filter((dimension) => getDimension(policy, dimension) !== undefined);
}

/** The six V1 fields only — what MK consumers and today's governance responses read. */
export function toV1GovernancePolicy(policy: AgentGovernancePolicy): AgentGovernancePolicy {
  return normalizeAgentGovernancePolicy({
    permissions: policy.permissions,
    monthlyBudgetCents: policy.monthlyBudgetCents,
    destructiveActions: policy.destructiveActions,
    dataScopes: policy.dataScopes,
    providers: policy.providers,
    minimumApproval: policy.minimumApproval,
  });
}

// ---------------------------------------------------------------------------
// Parse (upgrade V1 on read) and merge (V1 writes keep V2)
// ---------------------------------------------------------------------------

export type AgentAccessPolicyParseResult =
  | { success: true; policy: AgentAccessPolicy }
  | { success: false; error: AgentAccessPolicyParseError };

/** Non-throwing `parseAccessPolicy`. */
export function safeParseAccessPolicy(stored: unknown): AgentAccessPolicyParseResult {
  const parsed = storedAgentGovernancePolicySchema.safeParse(stored);
  if (!parsed.success) {
    return {
      success: false,
      error: new AgentAccessPolicyParseError(
        parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      ),
    };
  }
  const { policyVersion: _policyVersion, see, do: doValue, talk, ...v1 } = parsed.data;
  return {
    success: true,
    policy: {
      ...toV1GovernancePolicy(v1),
      policyVersion: AGENT_ACCESS_POLICY_VERSION,
      ...normalizeV2Fields({ see, do: doValue, talk }),
    },
  };
}

/**
 * Read a stored governance side (owner ceiling or steward request) as V2.
 *
 * A stored V1 row is upgraded on read: same six fields, `policyVersion: 2`,
 * no V2 dimensions (= not restricted by V2). The result is normalized (lists
 * sorted and de-duplicated, id lists dropped for non-`listed` contact modes).
 * Throws `AgentAccessPolicyParseError` when the value is neither shape.
 */
export function parseAccessPolicy(stored: unknown): AgentAccessPolicy {
  const result = safeParseAccessPolicy(stored);
  if (!result.success) throw result.error;
  return result.policy;
}

/**
 * A write to one governance side. Today's writers send a whole V1 side (six
 * fields) and nothing else; a V2-aware writer (profile application) may also
 * supply V2 dimensions and must name any dimension it removes in `clear`.
 */
export type AgentAccessPolicyWrite = AgentGovernancePolicy &
  AgentAccessPolicyV2Fields & {
    policyVersion?: typeof AGENT_ACCESS_POLICY_VERSION;
    /** V2 dimensions this write removes. Omitting a dimension from the write never clears it. */
    clear?: readonly AgentAccessV2Dimension[];
  };

/**
 * Merge a write into the stored side (access LLD §3.4).
 *
 * - The six V1 fields are replaced by the write's, as today's writers expect.
 * - A V2 dimension the write supplies replaces the stored one.
 * - A V2 dimension the write omits is KEPT, unless the write names it in
 *   `clear`. So a V1-shaped write (every legacy writer) never erases V2 limits.
 * - Supplying and clearing the same dimension throws `AgentAccessPolicyWriteError`.
 *
 * V1 in, V1 out: when no V2 dimension remains, the result carries no
 * `policyVersion` and no V2 keys, so MK rows written through the legacy paths
 * stay byte-identical to today's.
 */
export function mergeAccessPolicyWrite(
  stored: StoredAgentGovernancePolicy | null | undefined,
  incoming: AgentAccessPolicyWrite,
): StoredAgentGovernancePolicy {
  const base = stored ? parseAccessPolicy(stored) : null;
  const clear = new Set<AgentAccessV2Dimension>(incoming.clear ?? []);
  const incomingV2 = normalizeV2Fields({ see: incoming.see, do: incoming.do, talk: incoming.talk });

  const conflicts = AGENT_ACCESS_V2_DIMENSIONS.filter(
    (dimension) => clear.has(dimension) && getDimension(incomingV2, dimension) !== undefined,
  );
  if (conflicts.length > 0) throw new AgentAccessPolicyWriteError(conflicts);

  const merged: AgentAccessPolicyV2Fields = {};
  for (const dimension of AGENT_ACCESS_V2_DIMENSIONS) {
    const supplied = getDimension(incomingV2, dimension);
    if (supplied !== undefined) {
      setDimension(merged, dimension, supplied);
      continue;
    }
    if (clear.has(dimension)) continue;
    const kept = getDimension(base, dimension);
    if (kept !== undefined) setDimension(merged, dimension, kept);
  }

  const v1 = toV1GovernancePolicy(incoming);
  if (definedAccessV2Dimensions(merged).length === 0) return v1;
  return { ...v1, policyVersion: AGENT_ACCESS_POLICY_VERSION, ...merged };
}

/**
 * The write that makes a side equal `next` exactly — what profile application
 * sends for the request side. Every V2 dimension stored but absent from `next`
 * is named in `clear`, so the removal is explicit and auditable rather than a
 * side effect of omission.
 */
export function accessPolicyReplacementWrite(
  stored: StoredAgentGovernancePolicy | null | undefined,
  next: AgentAccessPolicy,
): AgentAccessPolicyWrite {
  const base = stored ? parseAccessPolicy(stored) : null;
  const nextDimensions = new Set(definedAccessV2Dimensions(next));
  const clear = definedAccessV2Dimensions(base).filter((dimension) => !nextDimensions.has(dimension));
  const { policyVersion: _policyVersion, ...rest } = next;
  return { ...rest, policyVersion: AGENT_ACCESS_POLICY_VERSION, ...(clear.length > 0 ? { clear } : {}) };
}

// ---------------------------------------------------------------------------
// Send precedence (access LLD §3.2)
// ---------------------------------------------------------------------------

export const AGENT_SEND_PRECEDENCE_SOURCES = [
  "provider",
  "destructive_actions",
  "connection_autonomy",
  "access_policy_v2",
] as const;
export type AgentSendPrecedenceSource = (typeof AGENT_SEND_PRECEDENCE_SOURCES)[number];

export interface AgentSendPrecedenceLayers {
  /** Rule 1: the provider always files an approval (HubSpot files `connector_send`). */
  providerMandatesApproval?: boolean;
  /** Rule 2: the V1 `destructiveActions` ceiling, when the action is destructive (MK today). */
  destructiveActions?: AgentDestructiveActionMode | null;
  /** Rule 3: connection autonomy, already resolved workspace default → connection → agent override. */
  connectionAutonomy?: AgentAccessMode | null;
  /** Rule 4: the effective V2 `do.connections[].send` mode. */
  accessPolicyV2?: AgentAccessMode | null;
}

const DESTRUCTIVE_TO_MODE: Record<AgentDestructiveActionMode, AgentAccessMode> = {
  blocked: "never",
  approval_required: "approve",
  allowed: "auto",
};

/**
 * The most restrictive rule wins. On a tie the earlier rule in the table is
 * named, so `decidedBy` points at the rule a person would have to change.
 * `auto` from V2 therefore never removes an approval rules 1–3 require.
 */
export function resolveSendPrecedence(layers: AgentSendPrecedenceLayers): {
  requirement: AgentAccessMode;
  decidedBy: AgentSendPrecedenceSource | null;
} {
  const candidates: Array<[AgentSendPrecedenceSource, AgentAccessMode | null]> = [
    ["provider", layers.providerMandatesApproval ? "approve" : null],
    ["destructive_actions", layers.destructiveActions ? DESTRUCTIVE_TO_MODE[layers.destructiveActions] : null],
    ["connection_autonomy", layers.connectionAutonomy ?? null],
    ["access_policy_v2", layers.accessPolicyV2 ?? null],
  ];
  let requirement: AgentAccessMode = "auto";
  let decidedBy: AgentSendPrecedenceSource | null = null;
  for (const [source, mode] of candidates) {
    if (mode === null) continue;
    if (MODE_RANK[mode] < MODE_RANK[requirement]) {
      requirement = mode;
      decidedBy = source;
    }
  }
  return { requirement, decidedBy };
}

// ---------------------------------------------------------------------------
// evaluateAccessV2
// ---------------------------------------------------------------------------

export const AGENT_ACCESS_PEOPLE_PURPOSES = ["question", "approval", "bridge_task"] as const;
export type AgentAccessPeoplePurpose = (typeof AGENT_ACCESS_PEOPLE_PURPOSES)[number];

/**
 * One access check: the dimension, what is being reached, and (for agent
 * contact) the channel. The same shape is the server's
 * `checkAgentAccess(db, { companyId, agentId, ...check })` input.
 *
 * Callers resolve ids before checking: a skill reference becomes its company
 * skill key, an issue becomes its project id.
 */
export type AgentAccessV2Check =
  | {
      dimension: "see.projects";
      /** `null` = an issue with no project, which project scopes do not restrict. */
      target: { projectId: string | null };
    }
  | { dimension: "see.connections"; target: { connectionId: string; dataScope?: string | null } }
  | {
      dimension: "do.connections";
      target: {
        connectionId: string;
        actionClass: "draft" | "send";
        /** True when this action is being filed for, or executed after, a human approval. */
        onApprovalPath: boolean;
      };
    }
  | { dimension: "do.skills"; target: { skillKey: string } }
  | {
      /** Outbound: checked on the SOURCE agent's policy; `target` is the agent being reached. */
      dimension: "talk.agents";
      target: { agentId: string };
      via: AgentAccessContactVia;
    }
  | {
      /** Inbound: checked on the RECIPIENT agent's policy; `target` is who is reaching it. */
      dimension: "talk.inbound";
      target: { kind: "agent"; agentId: string } | { kind: "user"; userId: string };
      via: AgentAccessContactVia;
    }
  | { dimension: "talk.people"; target: { userId: string; purpose: AgentAccessPeoplePurpose } }
  | {
      dimension: "talk.external";
      /** An email address, a URL or a bare domain. Compared case-insensitively. */
      target: { connectionId: string; externalTarget: string };
    };

/** Live facts read at check time. Nothing here is ever stored in the policy. */
export interface AgentAccessV2Context {
  /** The agent whose policy is evaluated (the source for outbound checks, the recipient for `talk.inbound`). */
  agentId: string;
  /** From live `agents.reportsTo`: every manager up the chain, and the agent's direct reports. */
  reportsChain: { managerAgentIds: readonly string[]; directReportAgentIds: readonly string[] };
  /** The always-reachable people (access LLD §4 invariants). */
  escalation: { accountableUserId: string | null; stewardUserId: string | null; adminUserIds: readonly string[] };
  /** `talk.inbound`: the source actor has configuration authority over this agent, so it is never blocked. */
  sourceHasConfigurationAuthority?: boolean;
  /** `do.skills`: the platform's required skills (by key), always allowed. */
  requiredSkillKeys?: readonly string[];
  /** `do.connections`: what rules 1–3 of the send precedence already require (`resolveSendPrecedence` without V2). Default `auto`. */
  legacySendRequirement?: AgentAccessMode;
}

export type AgentAccessV2Side = "ceiling" | "request" | "fixed";

export type AgentAccessV2Decision =
  | { decision: "allow" }
  | {
      decision: "refuse";
      dimension: AgentAccessV2Dimension;
      /** Stable machine-readable rule, e.g. `see.projects.not_listed`. */
      rule: string;
      /** Plain-language description of what IS allowed on the refusing side. */
      allowedSummary: string;
      /** Which side refused: the admin ceiling (clipped), the steward/accountable request, or a fixed rule. */
      side: AgentAccessV2Side;
    };

type Refusal = Extract<AgentAccessV2Decision, { decision: "refuse" }>;
const ALLOW: AgentAccessV2Decision = Object.freeze({ decision: "allow" }) as AgentAccessV2Decision;

function plural(count: number, noun: string): string {
  return `${count} listed ${noun}${count === 1 ? "" : "s"}`;
}

function listSummary(scope: AgentAccessListScope, noun: string): string {
  if (scope.mode === "all") return `All ${noun}s`;
  return scope.ids.length === 0 ? `No ${noun}s` : plural(scope.ids.length, noun);
}

function contactSummary(scope: AgentAccessContactScope, noun: "agent" | "person"): string {
  switch (scope.mode) {
    case "any":
      return noun === "agent" ? "Any agent" : "Anyone";
    case "listed": {
      const count = noun === "agent" ? (scope.agentIds ?? []).length : (scope.userIds ?? []).length;
      if (count === 0) return noun === "agent" ? "No agents" : "No people";
      return noun === "agent" ? plural(count, "agent") : `${count} listed ${count === 1 ? "person" : "people"}`;
    }
    case "reports_chain":
      return noun === "agent"
        ? "Agents in its reporting line (managers and direct reports)"
        : "Its accountable person, steward and company admins";
    case "accountable_only":
      return noun === "agent" ? "No agents (accountable people only)" : "Its accountable person, steward and company admins";
  }
}

function isEscalationContact(userId: string, context: AgentAccessV2Context): boolean {
  const { accountableUserId, stewardUserId, adminUserIds } = context.escalation;
  return userId === accountableUserId || userId === stewardUserId || adminUserIds.includes(userId);
}

/**
 * Does a contact scope admit this principal? `reports_chain` is computed from
 * the live chain in `context`; no person is in an agent's `reportsTo` chain,
 * so for people it resolves to the escalation contacts, the same as
 * `accountable_only`.
 */
function contactAllows(
  scope: AgentAccessContactScope,
  principal: { kind: "agent"; agentId: string } | { kind: "user"; userId: string },
  context: AgentAccessV2Context,
): { ok: true } | { ok: false; reason: string } {
  switch (scope.mode) {
    case "any":
      return { ok: true };
    case "listed":
      if (principal.kind === "agent") {
        return (scope.agentIds ?? []).includes(principal.agentId) ? { ok: true } : { ok: false, reason: "not_listed" };
      }
      return (scope.userIds ?? []).includes(principal.userId) ? { ok: true } : { ok: false, reason: "not_listed" };
    case "reports_chain":
      if (principal.kind === "agent") {
        const { managerAgentIds, directReportAgentIds } = context.reportsChain;
        return managerAgentIds.includes(principal.agentId) || directReportAgentIds.includes(principal.agentId)
          ? { ok: true }
          : { ok: false, reason: "not_in_reports_chain" };
      }
      return isEscalationContact(principal.userId, context) ? { ok: true } : { ok: false, reason: "not_in_reports_chain" };
    case "accountable_only":
      if (principal.kind === "agent") return { ok: false, reason: "accountable_only" };
      return isEscalationContact(principal.userId, context) ? { ok: true } : { ok: false, reason: "accountable_only" };
  }
}

function externalDomain(target: string): string {
  const value = normalizeExternalValue(target);
  const at = value.lastIndexOf("@");
  if (at !== -1) return value.slice(at + 1);
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(value)) return new URL(value).hostname;
  } catch {
    // not a URL; fall through to the bare value
  }
  return value.split("/")[0] ?? value;
}

/**
 * Evaluate one V2 check against the two stored sides (access LLD §3.2).
 *
 * The target must be allowed by the ceiling AND by the request. A side that
 * omits the dimension places no restriction. The ceiling is checked first, so
 * a refusal by both reports the ceiling (the item is clipped, and only an
 * admin can raise it). Fixed rules (self-contact, required skills, the
 * escalation path, configuration authority, bridge ownership) are applied
 * before either side.
 *
 * Pure and narrow-only: `allow` means "V2 adds no restriction", never "allowed".
 */
export function evaluateAccessV2(
  ceiling: AgentAccessPolicySideInput,
  request: AgentAccessPolicySideInput,
  check: AgentAccessV2Check,
  context: AgentAccessV2Context,
): AgentAccessV2Decision {
  const sides: Array<[Exclude<AgentAccessV2Side, "fixed">, AgentAccessPolicyV2Fields]> = [];
  if (ceiling) sides.push(["ceiling", normalizeV2Fields(ceiling)]);
  if (request) sides.push(["request", normalizeV2Fields(request)]);

  const refuse = (side: AgentAccessV2Side, reason: string, allowedSummary: string): Refusal => ({
    decision: "refuse",
    dimension: check.dimension,
    rule: `${check.dimension}.${reason}`,
    allowedSummary,
    side,
  });

  switch (check.dimension) {
    case "see.projects": {
      if (check.target.projectId === null) return ALLOW;
      for (const [side, policy] of sides) {
        const scope = policy.see?.projects;
        if (!scope || scope.mode === "all") continue;
        if (!scope.ids.includes(check.target.projectId)) return refuse(side, "not_listed", listSummary(scope, "project"));
      }
      return ALLOW;
    }

    case "see.connections": {
      for (const [side, policy] of sides) {
        const entries = policy.see?.connections;
        if (!entries) continue;
        const entry = entries.find((candidate) => candidate.connectionId === check.target.connectionId);
        if (!entry) return refuse(side, "not_listed", plural(entries.length, "connection"));
        const scope = check.target.dataScope;
        if (scope && !policyListAllows(entry.dataScopes, scope)) {
          return refuse(
            side,
            "data_scope_not_listed",
            entry.dataScopes.length === 0 ? "No data scopes on this connection" : `Data scopes: ${entry.dataScopes.join(", ")}`,
          );
        }
      }
      return ALLOW;
    }

    case "do.connections": {
      const { connectionId, actionClass, onApprovalPath } = check.target;
      let mode: AgentAccessMode = "auto";
      let modeSide: Exclude<AgentAccessV2Side, "fixed"> | null = null;
      for (const [side, policy] of sides) {
        const entries = policy.do?.connections;
        if (!entries) continue;
        const entry = entries.find((candidate) => candidate.connectionId === connectionId);
        // A connection the side does not list is `never` on that side.
        const sideMode: AgentAccessMode = entry ? entry[actionClass] : "never";
        if (MODE_RANK[sideMode] < MODE_RANK[mode]) {
          mode = sideMode;
          modeSide = side;
        }
      }
      if (modeSide === null || mode === "auto") return ALLOW;
      if (mode === "never") {
        return refuse(modeSide, `${actionClass}_never`, `This agent may not ${actionClass} through this connection`);
      }
      // `approve`: V2 refuses only when it is the rule that adds the approval.
      // When rules 1–3 already require one (or refuse), the legacy path owns the outcome.
      const legacy = context.legacySendRequirement ?? "auto";
      if (legacy !== "auto" || onApprovalPath) return ALLOW;
      return refuse(modeSide, `${actionClass}_approval_required`, `Every ${actionClass} through this connection needs a person's approval`);
    }

    case "do.skills": {
      if (context.requiredSkillKeys?.includes(check.target.skillKey)) return ALLOW;
      for (const [side, policy] of sides) {
        const scope = policy.do?.skills;
        if (!scope || scope.mode === "all") continue;
        if (!scope.ids.includes(check.target.skillKey)) return refuse(side, "not_listed", listSummary(scope, "skill"));
      }
      return ALLOW;
    }

    case "talk.agents": {
      if (check.target.agentId === context.agentId) return ALLOW;
      for (const [side, policy] of sides) {
        const scope = policy.talk?.agents;
        if (!scope) continue;
        if (!scope.via.includes(check.via)) {
          return refuse(
            side,
            "via_not_allowed",
            scope.via.length === 0 ? "No ways to reach other agents" : `Only by ${scope.via.join(", ")}`,
          );
        }
        const result = contactAllows(scope, { kind: "agent", agentId: check.target.agentId }, context);
        if (!result.ok) return refuse(side, result.reason, contactSummary(scope, "agent"));
      }
      return ALLOW;
    }

    case "talk.inbound": {
      if (context.sourceHasConfigurationAuthority) return ALLOW;
      if (check.target.kind === "agent" && check.target.agentId === context.agentId) return ALLOW;
      for (const [side, policy] of sides) {
        const scope = policy.talk?.inbound;
        if (!scope) continue;
        const result = contactAllows(scope, check.target, context);
        if (!result.ok) {
          return refuse(side, result.reason, contactSummary(scope, check.target.kind === "agent" ? "agent" : "person"));
        }
      }
      return ALLOW;
    }

    case "talk.people": {
      const { userId, purpose } = check.target;
      const { accountableUserId, stewardUserId } = context.escalation;
      if (purpose === "bridge_task") {
        // Bridge tasks run on a person's own machine: only the steward's or the
        // accountable user's endpoint, always (access LLD §4, talk.people row).
        return userId === stewardUserId || userId === accountableUserId
          ? ALLOW
          : refuse("fixed", "bridge_owner_only", "Only its steward's or accountable person's machine");
      }
      // The escalation path is always open for questions and approvals.
      if (isEscalationContact(userId, context)) return ALLOW;
      for (const [side, policy] of sides) {
        const scope = policy.talk?.people;
        if (!scope) continue;
        const result = contactAllows(scope, { kind: "user", userId }, context);
        if (!result.ok) {
          return refuse(side, result.reason, `${contactSummary(scope, "person")}; its accountable person, steward and admins are always reachable`);
        }
      }
      return ALLOW;
    }

    case "talk.external": {
      const { connectionId, externalTarget } = check.target;
      for (const [side, policy] of sides) {
        const entries = policy.talk?.external;
        if (!entries) continue;
        const entry = entries.find((candidate) => candidate.connectionId === connectionId);
        if (!entry) return refuse(side, "connection_not_listed", "No external targets through this connection");
        const { mode, values } = entry.targets;
        if (mode === "any") continue;
        if (mode === "listed" && !values.includes(normalizeExternalValue(externalTarget))) {
          return refuse(side, "target_not_listed", values.length === 0 ? "No external targets" : plural(values.length, "target"));
        }
        if (mode === "domains" && !values.includes(externalDomain(externalTarget))) {
          return refuse(side, "domain_not_listed", values.length === 0 ? "No external domains" : `Domains: ${values.join(", ")}`);
        }
      }
      return ALLOW;
    }
  }
}

// ---------------------------------------------------------------------------
// Clipping: where a request asks for more than the ceiling allows
// ---------------------------------------------------------------------------

export interface AgentAccessV2Clip {
  dimension: AgentAccessV2Dimension;
  /** Plain language, e.g. "Asks for every project; the ceiling lists 2". */
  detail: string;
  /** Ids or values the request names beyond the ceiling, when there is a list to name. */
  values?: string[];
  /** True when the two scopes are different predicates that cannot be compared (e.g. `listed` vs `reports_chain`). */
  incomparable?: boolean;
}

function listClip(ceiling: AgentAccessListScope, request: AgentAccessListScope, noun: string): Omit<AgentAccessV2Clip, "dimension"> | null {
  if (ceiling.mode === "all") return null;
  if (request.mode === "all") return { detail: `Asks for all ${noun}s; the ceiling allows ${listSummary(ceiling, noun).toLowerCase()}` };
  const allowed = new Set(ceiling.ids);
  const over = request.ids.filter((id) => !allowed.has(id));
  return over.length > 0 ? { detail: `Asks for ${noun}s the ceiling does not list`, values: over } : null;
}

function contactClip(
  ceiling: AgentAccessContactScope,
  request: AgentAccessContactScope,
  noun: "agent" | "person",
): Omit<AgentAccessV2Clip, "dimension"> | null {
  if (ceiling.mode === "any") return null;
  if (request.mode === "any") return { detail: `Asks to reach anyone; the ceiling allows ${contactSummary(ceiling, noun).toLowerCase()}` };
  if (ceiling.mode === "listed" && request.mode === "listed") {
    const over = [
      ...(request.agentIds ?? []).filter((id) => !(ceiling.agentIds ?? []).includes(id)),
      ...(request.userIds ?? []).filter((id) => !(ceiling.userIds ?? []).includes(id)),
    ];
    return over.length > 0 ? { detail: `Asks to reach ${noun === "agent" ? "agents" : "people"} the ceiling does not list`, values: over } : null;
  }
  if (ceiling.mode === request.mode) return null;
  // `accountable_only` is the narrowest predicate; asking for it never exceeds a ceiling.
  if (request.mode === "accountable_only") return null;
  return { detail: `Asks for "${request.mode}" where the ceiling allows "${ceiling.mode}"`, incomparable: true };
}

/**
 * Every V2 dimension where the request side asks for more than the ceiling
 * (access LLD §3.2 "clipping"). An omitted request dimension asks for
 * "whatever the ceiling allows" and is never clipped; an omitted ceiling
 * dimension clips nothing. Effective access is still the intersection —
 * clipping is what the owner is shown, with who can raise the ceiling.
 */
export function collectAccessV2Clipping(
  ceiling: AgentAccessPolicySideInput,
  request: AgentAccessPolicySideInput,
): AgentAccessV2Clip[] {
  if (!ceiling || !request) return [];
  const c = normalizeV2Fields(ceiling);
  const r = normalizeV2Fields(request);
  const clips: AgentAccessV2Clip[] = [];
  const push = (dimension: AgentAccessV2Dimension, clip: Omit<AgentAccessV2Clip, "dimension"> | null) => {
    if (clip) clips.push({ dimension, ...clip });
  };

  if (c.see?.projects && r.see?.projects) push("see.projects", listClip(c.see.projects, r.see.projects, "project"));

  if (c.see?.connections && r.see?.connections) {
    const ceilingById = new Map(c.see.connections.map((entry) => [entry.connectionId, entry]));
    const missing = r.see.connections.filter((entry) => !ceilingById.has(entry.connectionId)).map((entry) => entry.connectionId);
    const scopeOver = r.see.connections.flatMap((entry) => {
      const bound = ceilingById.get(entry.connectionId);
      if (!bound || bound.dataScopes.includes(AGENT_POLICY_WILDCARD)) return [];
      if (entry.dataScopes.includes(AGENT_POLICY_WILDCARD)) return [`${entry.connectionId}:*`];
      return entry.dataScopes.filter((scope) => !bound.dataScopes.includes(scope)).map((scope) => `${entry.connectionId}:${scope}`);
    });
    if (missing.length > 0) push("see.connections", { detail: "Asks to read connections the ceiling does not list", values: missing });
    if (scopeOver.length > 0) push("see.connections", { detail: "Asks for data scopes the ceiling does not allow", values: scopeOver });
  }

  if (c.do?.connections && r.do?.connections) {
    const ceilingById = new Map(c.do.connections.map((entry) => [entry.connectionId, entry]));
    const over = r.do.connections.flatMap((entry) => {
      const bound = ceilingById.get(entry.connectionId);
      const values: string[] = [];
      for (const actionClass of ["draft", "send"] as const) {
        const ceilingMode: AgentAccessMode = bound ? bound[actionClass] : "never";
        if (MODE_RANK[entry[actionClass]] > MODE_RANK[ceilingMode]) values.push(`${entry.connectionId}:${actionClass}=${entry[actionClass]}`);
      }
      return values;
    });
    if (over.length > 0) push("do.connections", { detail: "Asks for less approval than the ceiling requires", values: over });
  }

  if (c.do?.skills && r.do?.skills) push("do.skills", listClip(c.do.skills, r.do.skills, "skill"));

  if (c.talk?.agents && r.talk?.agents) {
    push("talk.agents", contactClip(c.talk.agents, r.talk.agents, "agent"));
    const viaOver = r.talk.agents.via.filter((via) => !c.talk!.agents!.via.includes(via));
    if (viaOver.length > 0) push("talk.agents", { detail: "Asks to reach agents in ways the ceiling does not allow", values: viaOver });
  }
  if (c.talk?.people && r.talk?.people) push("talk.people", contactClip(c.talk.people, r.talk.people, "person"));
  if (c.talk?.inbound && r.talk?.inbound) push("talk.inbound", contactClip(c.talk.inbound, r.talk.inbound, "agent"));

  if (c.talk?.external && r.talk?.external) {
    const ceilingById = new Map(c.talk.external.map((entry) => [entry.connectionId, entry]));
    const over: string[] = [];
    let incomparable = false;
    for (const entry of r.talk.external) {
      const bound = ceilingById.get(entry.connectionId);
      if (!bound) {
        over.push(entry.connectionId);
        continue;
      }
      if (bound.targets.mode === "any") continue;
      if (entry.targets.mode === "any") {
        over.push(`${entry.connectionId}:*`);
        continue;
      }
      if (bound.targets.mode !== entry.targets.mode) {
        incomparable = true;
        over.push(`${entry.connectionId}:${entry.targets.mode}`);
        continue;
      }
      for (const value of entry.targets.values) {
        if (!bound.targets.values.includes(value)) over.push(`${entry.connectionId}:${value}`);
      }
    }
    if (over.length > 0) {
      push("talk.external", {
        detail: "Asks for external targets the ceiling does not allow",
        values: over,
        ...(incomparable ? { incomparable: true } : {}),
      });
    }
  }

  return clips;
}
