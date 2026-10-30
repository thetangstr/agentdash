import type { Db } from "@paperclipai/db";
import {
  AGENT_ACCESS_V2_DIMENSIONS,
  AGENT_POLICY_WILDCARD,
  AGENT_PROFILE_FIELD_AUTHORITIES,
  agentProfileChangePayloadSchema,
  agentProfileHireFieldsSchema,
  hirePayloadNamesProfile,
  collectAccessV2Clipping,
  collectCeilingViolations,
  definedAccessV2Dimensions,
  toV1GovernancePolicy,
  type AgentAccessContactScope,
  type AgentAccessListScope,
  type AgentAccessMode,
  type AgentAccessPolicy,
  type AgentAccessV2Clip,
  type AgentAccessV2Dimension,
  type AgentGovernancePolicy,
  type AgentProfileAccessChange,
  type AgentProfileChangePayload,
  type AgentProfileDecisionRecord,
  type AgentProfileDiffEntry,
  type AgentProfileFieldAuthority,
  type AgentProfileFieldAuthorityEntry,
  type AgentProfileHireFields,
} from "@paperclipai/shared";
import { forbidden, unprocessable } from "../errors.js";
import { accessService } from "./access.js";
import { agentAccountabilityService } from "./agent-accountability.js";
import { agentGovernanceService } from "./agent-governance.js";
import { agentStewardshipService } from "./agent-stewardships.js";

/**
 * AgentDash: Agent Performance Management gate 2 — who may change which part
 * of an operating profile (overview LLD §4.1, rule A6; gate 2 spec P2.2).
 *
 * A6: deciding a changed field needs EXACTLY the authority that changing it
 * directly needs today — never more. Each field mirrors today's guard:
 *
 * | Field                                   | Guard mirrored today                                                      | Who |
 * | --------------------------------------- | ------------------------------------------------------------------------- | --- |
 * | `skills`                                | `POST /agents/:id/skills/sync` → `assertCanUpdateAgent` →                  | `agentConfigurationAuthority` (ownership.ts) = `resolveConfigurationAuthority`: admin, or (agentdash_mk) the active steward / the creator |
 * | `access` within the ceiling (request)   | `PUT …/governance/request` → `requireRequestAuthority`                     | the same `resolveConfigurationAuthority` (no accountable-only person; outside agentdash_mk, admin only) |
 * | `access` beyond the ceiling             | `PUT …/governance/ceiling` → `requireCeilingAuthority`                     | admin: local board, instance admin, `agents:create` |
 * | `runtime` (adapter, model, heartbeat, environment) | `PATCH /agents/:id` → `assertStewardPatchScope` (steward allowlist excludes adapterConfig, runtimeConfig, defaultEnvironmentId, adapterType) | configuration authority `admin` |
 * | routine binding                         | `assertCanWriteRoutines` (authz.ts): `tasks:assign`                         | `tasks:assign`, on top of the profile-only rule (a binding lives in a responsibility) |
 * | identity / style / responsibilities / criteria / knowledge / rhythm text | none — profile-only fields, no setting exists today | the steward, the accountable person, or an admin |
 *
 * The `required` class recorded per field (`AgentProfileFieldAuthority`, frozen
 * in P2.1) is coarser than this table: skills and access-within-ceiling are
 * labelled `steward_or_accountable`, with a reason naming the real rule. The
 * decider check (`assertProfileChangeDecider`) applies the table, per field.
 *
 * The proposing agent can never decide: deciding is human-only. A human
 * author holding the authority may approve their own draft; it is recorded as
 * a self-approval. Applies to every company, not only `agentdash_mk`.
 */

// ---------------------------------------------------------------------------
// Who holds what
// ---------------------------------------------------------------------------

export interface ProfileAuthorityActor {
  type?: string | null;
  userId?: string | null;
  agentId?: string | null;
  source?: string | null;
  isInstanceAdmin?: boolean;
}

export interface ProfileAuthorityHolder {
  userId: string | null;
  /** `agents:create` (role or grant), an instance admin, or the local board. */
  isAdmin: boolean;
  /**
   * Today's direct configuration authority over THIS agent:
   * `agentGovernanceService.resolveConfigurationAuthority`, the function behind
   * `agentConfigurationAuthority` (ownership.ts), `assertCanUpdateAgent` (skill
   * sync) and `requireRequestAuthority` (governance request). Null = none.
   */
  configuration: "admin" | "steward" | null;
  /** The agent's active steward, or (agentdash_mk) its creator, who has steward-tier configuration authority. */
  isSteward: boolean;
  /** The human who answers for the agent (`agentAccountabilityService`). */
  isAccountable: boolean;
  /** The routine-write rule (`tasks:assign`). */
  canWriteRoutines: boolean;
}

const AUTHORITY_RANK: Record<AgentProfileFieldAuthority, number> = Object.fromEntries(
  AGENT_PROFILE_FIELD_AUTHORITIES.map((authority, index) => [authority, index]),
) as Record<AgentProfileFieldAuthority, number>;

export const NO_PROFILE_AUTHORITY: ProfileAuthorityHolder = Object.freeze({
  userId: null,
  isAdmin: false,
  configuration: null,
  isSteward: false,
  isAccountable: false,
  canWriteRoutines: false,
});

/**
 * Resolve a human's authority over one agent from CURRENT state. Agents hold
 * none: profile authority is human authority.
 */
export async function resolveProfileAuthorityHolder(
  db: Db,
  scope: { companyId: string; agentId: string },
  actor: ProfileAuthorityActor,
): Promise<ProfileAuthorityHolder> {
  if (actor.type === "agent" || actor.agentId) return NO_PROFILE_AUTHORITY;
  const userId = actor.userId ?? null;
  const localBoard = actor.source === "local_implicit" || actor.isInstanceAdmin === true;
  if (!userId && !localBoard) return NO_PROFILE_AUTHORITY;
  const access = accessService(db);
  const [canCreateAgents, canAssign, steward, accountable, configurationAuthority] = await Promise.all([
    localBoard ? Promise.resolve(true) : access.canUser(scope.companyId, userId, "agents:create"),
    localBoard ? Promise.resolve(true) : access.canUser(scope.companyId, userId, "tasks:assign"),
    userId ? agentStewardshipService(db).activeByAgent(scope.companyId, scope.agentId) : Promise.resolve(null),
    userId ? agentAccountabilityService(db).resolveForAgent(scope.companyId, scope.agentId) : Promise.resolve(null),
    userId
      ? agentGovernanceService(db).resolveConfigurationAuthority(scope.companyId, scope.agentId, {
          type: "board",
          userId,
          source: actor.source ?? null,
          isInstanceAdmin: actor.isInstanceAdmin ?? false,
        })
      : Promise.resolve(null),
  ]);
  return {
    userId,
    isAdmin: canCreateAgents || configurationAuthority === "admin",
    configuration: configurationAuthority ?? (canCreateAgents ? "admin" : null),
    isSteward: Boolean(userId && steward?.userId === userId) || configurationAuthority === "steward",
    isAccountable: Boolean(userId && accountable?.userId && accountable.userId === userId),
    canWriteRoutines: canAssign,
  };
}

/** Which of today's guards a changed field mirrors (see the table above). */
export type ProfileFieldRule = "profile_only" | "agent_configuration" | "ceiling" | "host_configuration" | "routine_binding";

/** Does `holder` pass today's guard for `rule`? */
export function holderPassesFieldRule(holder: ProfileAuthorityHolder, rule: ProfileFieldRule): boolean {
  switch (rule) {
    case "profile_only":
      return holder.isAdmin || holder.isSteward || holder.isAccountable;
    case "agent_configuration":
      // `resolveConfigurationAuthority`: an accountable person without it is refused, as on the direct routes.
      return holder.configuration !== null;
    case "ceiling":
      // `requireCeilingAuthority` (routes/agent-governance.ts).
      return holder.isAdmin;
    case "host_configuration":
      // `assertStewardPatchScope` (routes/agents.ts): only configuration authority "admin" passes.
      return holder.configuration === "admin";
    case "routine_binding":
      // `assertCanWriteRoutines` (routes/authz.ts), on top of the responsibility it sits in.
      return holder.canWriteRoutines && holderPassesFieldRule(holder, "profile_only");
  }
}

/**
 * How a sufficient decider is recorded: "admin" when an admin-only field
 * changed; otherwise their relationship to the agent. Null when any field's
 * rule refuses them.
 */
export function profileDecisionRole(
  holder: ProfileAuthorityHolder,
  rules: readonly ProfileFieldRule[],
): AgentProfileDecisionRecord["decisionActorRole"] | null {
  if (!rules.every((rule) => holderPassesFieldRule(holder, rule))) return null;
  if (rules.some((rule) => rule === "ceiling" || rule === "host_configuration")) return "admin";
  if (rules.includes("agent_configuration")) return holder.configuration === "steward" ? "steward" : "admin";
  if (holder.isSteward) return "steward";
  if (holder.isAccountable) return "accountable";
  return "admin";
}

export function strongestProfileAuthority(entries: readonly { required: AgentProfileFieldAuthority }[]): AgentProfileFieldAuthority {
  return entries.reduce<AgentProfileFieldAuthority>(
    (strongest, entry) => (AUTHORITY_RANK[entry.required] > AUTHORITY_RANK[strongest] ? entry.required : strongest),
    "steward_or_accountable",
  );
}

// ---------------------------------------------------------------------------
// Field classification (pure)
// ---------------------------------------------------------------------------

const V1_FIELDS = ["permissions", "monthlyBudgetCents", "destructiveActions", "dataScopes", "providers", "minimumApproval"] as const;
type V1Field = (typeof V1_FIELDS)[number];

function decodePointer(pointer: string): string[] {
  if (pointer === "") return [];
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

const RUNTIME_REASON =
  "Runtime, adapter, model, heartbeat and environment settings run on the host; only an administrator with agents:create can change them";
const CEILING_REASON =
  "Asks for more than the admin ceiling allows; an administrator raises the ceiling as a separate recorded step";
const ROUTINE_REASON = "Binds a routine trigger; deciding needs the authority to edit routines (tasks:assign)";
const SKILLS_REASON =
  "Skills (installed only within access.do.skills): the skill-sync rule — the agent's steward or an administrator with agents:create";
const ACCESS_REASON =
  "Access within the admin ceiling: the governance request rule — the agent's steward or an administrator with agents:create";

/** Diff entries that add, remove or rebind a routine obligation. */
export function isRoutineBindingEntry(entry: AgentProfileDiffEntry): boolean {
  const tokens = decodePointer(entry.pointer);
  if (tokens[0] !== "responsibilities") return false;
  if (tokens.length >= 3 && tokens[2] === "obligation") return true;
  if (tokens.length === 2 && (entry.op === "add" || entry.op === "remove")) {
    const member = (entry.op === "add" ? entry.after : entry.before) as { obligation?: { kind?: string } } | undefined;
    return member?.obligation?.kind === "routine";
  }
  if (tokens.length === 1) {
    const values = [entry.before, entry.after].flatMap((value) => (Array.isArray(value) ? value : []));
    return values.some((member) => (member as { obligation?: { kind?: string } })?.obligation?.kind === "routine");
  }
  return false;
}

/** Where the request side asks beyond the ceiling: V1 fields and V2 dimensions. */
export function accessClipping(ceiling: AgentAccessPolicy, request: AgentAccessPolicy) {
  const v1 = new Set<V1Field>(
    collectCeilingViolations(toV1GovernancePolicy(ceiling), toV1GovernancePolicy(request)).map((violation) => violation.field),
  );
  const v2 = collectAccessV2Clipping(ceiling, request);
  return { v1, v2, v2Dimensions: new Set<AgentAccessV2Dimension>(v2.map((clip) => clip.dimension)) };
}

function accessPointerClipped(tokens: string[], clipping: ReturnType<typeof accessClipping>): boolean {
  const [, section, field] = tokens;
  if (!section) return clipping.v1.size > 0 || clipping.v2Dimensions.size > 0;
  if ((V1_FIELDS as readonly string[]).includes(section)) return clipping.v1.has(section as V1Field);
  if (section === "see" || section === "do" || section === "talk") {
    if (field) return clipping.v2Dimensions.has(`${section}.${field}` as AgentAccessV2Dimension);
    return [...clipping.v2Dimensions].some((dimension) => dimension.startsWith(`${section}.`));
  }
  return false;
}

/**
 * The authority each changed field needs (one entry per diff entry, same
 * pointer). `ceiling` is the owner ceiling and `request` the proposed access.
 */
export function classifyProfileFieldAuthority(input: {
  diff: readonly AgentProfileDiffEntry[];
  ceiling: AgentAccessPolicy;
  request: AgentAccessPolicy;
}): AgentProfileFieldAuthorityEntry[] {
  const clipping = accessClipping(input.ceiling, input.request);
  return input.diff.map((entry): AgentProfileFieldAuthorityEntry => {
    const tokens = decodePointer(entry.pointer);
    const top = tokens[0];
    if (top === undefined) {
      // A whole-body add (no base). Everything is new, so it needs everything.
      const clipped = clipping.v1.size > 0 || clipping.v2Dimensions.size > 0;
      return { pointer: entry.pointer, required: clipped ? "admin_ceiling" : "admin", reason: clipped ? CEILING_REASON : RUNTIME_REASON };
    }
    if (top === "runtime") return { pointer: entry.pointer, required: "admin", reason: RUNTIME_REASON };
    if (top === "access") {
      return accessPointerClipped(tokens, clipping)
        ? { pointer: entry.pointer, required: "admin_ceiling", reason: CEILING_REASON }
        : { pointer: entry.pointer, required: "steward_or_accountable", reason: ACCESS_REASON };
    }
    if (top === "skills") return { pointer: entry.pointer, required: "steward_or_accountable", reason: SKILLS_REASON };
    if (isRoutineBindingEntry(entry)) return { pointer: entry.pointer, required: "steward_or_accountable", reason: ROUTINE_REASON };
    return { pointer: entry.pointer, required: "steward_or_accountable", reason: null };
  });
}

/**
 * The guard a recorded `fieldAuthority` entry mirrors, from its pointer and
 * class — so the decision and the application re-check apply the table above
 * to the payload without re-reading the ceiling.
 */
export function profileFieldRuleOf(entry: { pointer: string; required: AgentProfileFieldAuthority }, diffEntry?: AgentProfileDiffEntry): ProfileFieldRule {
  if (entry.required === "admin_ceiling") return "ceiling";
  const top = decodePointer(entry.pointer)[0];
  if (top === undefined || top === "runtime" || entry.required === "admin") return "host_configuration";
  if (top === "access" || top === "skills") return "agent_configuration";
  if (diffEntry && isRoutineBindingEntry(diffEntry)) return "routine_binding";
  return "profile_only";
}

/** Responsibility keys added, removed or changed by `diff` (`after` is the proposed body). */
export function affectedResponsibilityKeys(
  diff: readonly AgentProfileDiffEntry[],
  after: { responsibilities: Array<{ key: string }> },
): string[] {
  const keys = new Set<string>();
  for (const entry of diff) {
    const tokens = decodePointer(entry.pointer);
    if (tokens[0] !== "responsibilities" || entry.op === "reorder") continue;
    if (entry.key) {
      keys.add(entry.key);
      continue;
    }
    if (tokens.length === 1) {
      for (const member of [entry.before, entry.after].flatMap((value) => (Array.isArray(value) ? value : []))) {
        const key = (member as { key?: unknown })?.key;
        if (typeof key === "string") keys.add(key);
      }
      continue;
    }
    const index = Number(tokens[1]);
    const key = Number.isInteger(index) ? after.responsibilities[index]?.key : undefined;
    if (key) keys.add(key);
  }
  return [...keys].sort();
}

// ---------------------------------------------------------------------------
// Access changes (pure): widening, narrowing and clipping, per dimension
// ---------------------------------------------------------------------------

type Comparison = "same" | "widens" | "narrows" | "changes";

function setCompare(before: Set<string>, after: Set<string>): Comparison {
  const beforeInAfter = [...before].every((value) => after.has(value));
  const afterInBefore = [...after].every((value) => before.has(value));
  if (beforeInAfter && afterInBefore) return "same";
  if (beforeInAfter) return "widens";
  if (afterInBefore) return "narrows";
  return "changes";
}

function wildcardListCompare(before: readonly string[], after: readonly string[]): Comparison {
  const beforeAll = before.includes(AGENT_POLICY_WILDCARD);
  const afterAll = after.includes(AGENT_POLICY_WILDCARD);
  if (beforeAll && afterAll) return "same";
  if (beforeAll) return "narrows";
  if (afterAll) return "widens";
  return setCompare(new Set(before), new Set(after));
}

function rankCompare(before: number, after: number): Comparison {
  return before === after ? "same" : after > before ? "widens" : "narrows";
}

const DESTRUCTIVE_RANK = { blocked: 0, approval_required: 1, allowed: 2 } as const;
// Less approval is wider access.
const APPROVAL_WIDTH = { none: 1, steward: 0 } as const;
const MODE_RANK: Record<AgentAccessMode, number> = { never: 0, approve: 1, auto: 2 };

function listScopeCompare(before: AgentAccessListScope | undefined, after: AgentAccessListScope | undefined): Comparison {
  const beforeAll = !before || before.mode === "all";
  const afterAll = !after || after.mode === "all";
  if (beforeAll && afterAll) return before?.mode === after?.mode ? "same" : "changes";
  if (beforeAll) return "narrows";
  if (afterAll) return "widens";
  return setCompare(new Set(before!.ids), new Set(after!.ids));
}

const CONTACT_WIDTH: Record<AgentAccessContactScope["mode"], number> = { any: 3, reports_chain: 1, listed: 1, accountable_only: 0 };

function contactCompare(before: AgentAccessContactScope | undefined, after: AgentAccessContactScope | undefined): Comparison {
  const beforeMode = before?.mode ?? "any";
  const afterMode = after?.mode ?? "any";
  if (beforeMode === "listed" && afterMode === "listed") {
    return setCompare(
      new Set([...(before?.agentIds ?? []), ...(before?.userIds ?? [])]),
      new Set([...(after?.agentIds ?? []), ...(after?.userIds ?? [])]),
    );
  }
  if (beforeMode === afterMode) return before === undefined && after === undefined ? "same" : before && after ? "same" : "changes";
  const rankBefore = CONTACT_WIDTH[beforeMode];
  const rankAfter = CONTACT_WIDTH[afterMode];
  // `listed` and `reports_chain` are different predicates: neither contains the other.
  if (rankBefore === rankAfter) return "changes";
  return rankAfter > rankBefore ? "widens" : "narrows";
}

function combine(...comparisons: Comparison[]): Comparison {
  const moved = comparisons.filter((comparison) => comparison !== "same");
  if (moved.length === 0) return "same";
  if (moved.every((comparison) => comparison === "widens")) return "widens";
  if (moved.every((comparison) => comparison === "narrows")) return "narrows";
  return "changes";
}

function dimensionCompare(dimension: AgentAccessV2Dimension, before: AgentAccessPolicy, after: AgentAccessPolicy): Comparison {
  switch (dimension) {
    case "see.projects":
      return listScopeCompare(before.see?.projects, after.see?.projects);
    case "do.skills":
      return listScopeCompare(before.do?.skills, after.do?.skills);
    case "see.connections": {
      const a = before.see?.connections;
      const b = after.see?.connections;
      if (!a && !b) return "same";
      if (!a) return "narrows";
      if (!b) return "widens";
      const aMap = new Map(a.map((entry) => [entry.connectionId, entry.dataScopes]));
      const bMap = new Map(b.map((entry) => [entry.connectionId, entry.dataScopes]));
      return combine(
        setCompare(new Set(aMap.keys()), new Set(bMap.keys())),
        ...[...aMap.keys()].filter((id) => bMap.has(id)).map((id) => wildcardListCompare(aMap.get(id)!, bMap.get(id)!)),
      );
    }
    case "do.connections": {
      const a = before.do?.connections;
      const b = after.do?.connections;
      if (!a && !b) return "same";
      if (!a) return "narrows";
      if (!b) return "widens";
      // A connection not listed is `never` for both action classes.
      const ids = new Set([...a.map((entry) => entry.connectionId), ...b.map((entry) => entry.connectionId)]);
      const mode = (list: typeof a, id: string, actionClass: "draft" | "send"): number =>
        MODE_RANK[list.find((entry) => entry.connectionId === id)?.[actionClass] ?? "never"];
      return combine(
        ...[...ids].flatMap((id) => [rankCompare(mode(a, id, "draft"), mode(b, id, "draft")), rankCompare(mode(a, id, "send"), mode(b, id, "send"))]),
      );
    }
    case "talk.agents": {
      const a = before.talk?.agents;
      const b = after.talk?.agents;
      if (!a && !b) return "same";
      if (!a) return "narrows";
      if (!b) return "widens";
      return combine(contactCompare(a, b), setCompare(new Set(a.via), new Set(b.via)));
    }
    case "talk.people":
      return before.talk?.people || after.talk?.people ? contactCompare(before.talk?.people, after.talk?.people) : "same";
    case "talk.inbound":
      return before.talk?.inbound || after.talk?.inbound ? contactCompare(before.talk?.inbound, after.talk?.inbound) : "same";
    case "talk.external": {
      const a = before.talk?.external;
      const b = after.talk?.external;
      if (!a && !b) return "same";
      if (!a) return "narrows";
      if (!b) return "widens";
      const aMap = new Map(a.map((entry) => [entry.connectionId, entry.targets]));
      const bMap = new Map(b.map((entry) => [entry.connectionId, entry.targets]));
      const shared = [...aMap.keys()].filter((id) => bMap.has(id)).map((id): Comparison => {
        const x = aMap.get(id)!;
        const y = bMap.get(id)!;
        if (x.mode === y.mode) return x.mode === "any" ? "same" : setCompare(new Set(x.values), new Set(y.values));
        if (x.mode === "any") return "narrows";
        if (y.mode === "any") return "widens";
        return "changes";
      });
      return combine(setCompare(new Set(aMap.keys()), new Set(bMap.keys())), ...shared);
    }
  }
}

function v1Compare(field: V1Field, before: AgentGovernancePolicy, after: AgentGovernancePolicy): Comparison {
  switch (field) {
    case "permissions":
    case "dataScopes":
    case "providers":
      return wildcardListCompare(before[field], after[field]);
    case "monthlyBudgetCents":
      return rankCompare(before.monthlyBudgetCents, after.monthlyBudgetCents);
    case "destructiveActions":
      return rankCompare(DESTRUCTIVE_RANK[before.destructiveActions], DESTRUCTIVE_RANK[after.destructiveActions]);
    case "minimumApproval":
      return rankCompare(APPROVAL_WIDTH[before.minimumApproval], APPROVAL_WIDTH[after.minimumApproval]);
  }
}

/**
 * Per dimension, how the proposed request moves from `before`, and whether
 * the ceiling clips it. Only dimensions that change are listed.
 */
export function computeAccessChanges(input: {
  before: AgentAccessPolicy;
  after: AgentAccessPolicy;
  ceiling: AgentAccessPolicy;
}): AgentProfileAccessChange[] {
  const { before, after, ceiling } = input;
  const clipping = accessClipping(ceiling, after);
  const changes: AgentProfileAccessChange[] = [];
  const beforeV1 = toV1GovernancePolicy(before);
  const afterV1 = toV1GovernancePolicy(after);
  for (const field of V1_FIELDS) {
    const comparison = v1Compare(field, beforeV1, afterV1);
    if (comparison === "same") continue;
    changes.push({ dimension: field, change: comparison, clippedByCeiling: clipping.v1.has(field), clip: null, detail: null });
  }
  const dimensions = new Set([...definedAccessV2Dimensions(before), ...definedAccessV2Dimensions(after)]);
  for (const dimension of AGENT_ACCESS_V2_DIMENSIONS) {
    if (!dimensions.has(dimension)) continue;
    const comparison = dimensionCompare(dimension, before, after);
    if (comparison === "same") continue;
    const clip: AgentAccessV2Clip | null = clipping.v2.find((entry) => entry.dimension === dimension) ?? null;
    changes.push({ dimension, change: comparison, clippedByCeiling: clip !== null, clip, detail: clip?.detail ?? null });
  }
  return changes;
}

// ---------------------------------------------------------------------------
// The decider
// ---------------------------------------------------------------------------

/**
 * AgentDash (APM gate 5): the profile fields of a `hire_agent` approval filed
 * by proposing an unbound draft; null when the hire carries no profile.
 * Throws 422 when it names a profile but the fields do not parse.
 */
export function parseHireProfileFields(payload: unknown): AgentProfileHireFields | null {
  if (!hirePayloadNamesProfile(payload)) return null;
  const parsed = agentProfileHireFieldsSchema.safeParse(payload);
  if (!parsed.success) {
    throw unprocessable("This hire approval has an invalid profile payload", { code: "AGENT_PROFILE_CHANGE_INVALID" });
  }
  return parsed.data as AgentProfileHireFields;
}

/**
 * AgentDash (APM gate 5): the field authority of a hire's first profile
 * application is the hire approval's own authority — `agents:create` (the
 * rule `assertCanDecideAgentLifecycleApproval` applies to deciding any hire).
 * An administrator passes every field rule an unbound draft can carry
 * (routine bindings are refused at propose time). Human-only, and the
 * proposing agent never decides, exactly as for a profile change.
 */
export async function assertHireProfileDecider(
  db: Db,
  approval: { companyId: string; type: string; payload: unknown },
  actor: ProfileAuthorityActor,
): Promise<AgentProfileDecisionRecord & { holder: ProfileAuthorityHolder }> {
  const fields = parseHireProfileFields(approval.payload);
  if (approval.type !== "hire_agent" || !fields) {
    throw unprocessable("This approval does not carry a hire profile", { code: "AGENT_PROFILE_CHANGE_INVALID" });
  }
  const payload = fields.profileChange;
  if (payload.proposedBy.kind === "agent" && actor.agentId === payload.proposedBy.agentId) {
    throw forbidden("The agent that proposed this hire cannot decide it");
  }
  if (actor.type === "agent" || actor.agentId || (!actor.userId && actor.source !== "local_implicit")) {
    throw forbidden("A person must decide a hire; an agent cannot approve or reject one");
  }
  const holder = await resolveProfileAuthorityHolder(db, { companyId: approval.companyId, agentId: payload.agentId }, actor);
  if (!holder.isAdmin) {
    throw forbidden("Applying a hire's operating profile needs the authority to decide the hire: the agents:create permission");
  }
  return {
    decisionActorRole: "admin",
    selfApproval: payload.proposedBy.kind === "user" && payload.proposedBy.userId === holder.userId,
    requiredAuthority: payload.requiredAuthority,
    holder,
  };
}

export function parseProfileChangePayload(payload: unknown): AgentProfileChangePayload {
  const parsed = agentProfileChangePayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw unprocessable("This profile change approval has an invalid payload", { code: "AGENT_PROFILE_CHANGE_INVALID" });
  }
  return parsed.data as AgentProfileChangePayload;
}

/**
 * The decider rule for `agent_profile_change`, in every company. Throws 403
 * unless `actor` is a human who holds the strongest authority any changed
 * field needs (and the routine-write rule for routine bindings). Returns how
 * the decision is recorded, including whether it is a self-approval.
 */
export async function assertProfileChangeDecider(
  db: Db,
  approval: { companyId: string; type: string; payload: unknown },
  actor: ProfileAuthorityActor,
): Promise<AgentProfileDecisionRecord & { holder: ProfileAuthorityHolder }> {
  const payload = parseProfileChangePayload(approval.payload);
  // Deciding is human-only: an agent — the proposer, the performance manager,
  // any other — has no profile authority, whoever stewards it.
  if (payload.proposedBy.kind === "agent" && actor.agentId === payload.proposedBy.agentId) {
    throw forbidden("The agent that proposed this profile change cannot decide it");
  }
  if (actor.type === "agent" || actor.agentId || (!actor.userId && actor.source !== "local_implicit")) {
    throw forbidden("A person must decide a profile change; an agent cannot approve or reject one");
  }
  const holder = await resolveProfileAuthorityHolder(db, { companyId: approval.companyId, agentId: payload.agentId }, actor);
  const required = strongestProfileAuthority(payload.fieldAuthority);
  const diffByPointer = new Map(payload.diff.map((entry) => [entry.pointer, entry]));
  const rules = [...new Set(payload.fieldAuthority.map((entry) => profileFieldRuleOf(entry, diffByPointer.get(entry.pointer))))];
  // A routine binding the payload's fieldAuthority missed (defensive) still needs the routine rule.
  if (payload.diff.some(isRoutineBindingEntry) && !rules.includes("routine_binding")) rules.push("routine_binding");
  if (rules.length === 0) rules.push("profile_only");
  const role = profileDecisionRole(holder, rules);
  if (!role) {
    const refused = rules.find((rule) => !holderPassesFieldRule(holder, rule))!;
    throw forbidden(
      {
        profile_only: "Only the agent's steward, its accountable person or an administrator can decide this profile change",
        agent_configuration:
          "This profile change touches the agent's skills or access; deciding it needs the same authority as changing them directly: the agent's steward or an administrator with agents:create",
        ceiling: "This profile change asks for access beyond the ceiling; only an administrator with agents:create can decide it",
        host_configuration: "This profile change touches runtime fields only an administrator with agents:create can change",
        routine_binding: "This profile change binds routines; deciding it needs the authority to edit routines (tasks:assign)",
      }[refused],
    );
  }
  return {
    decisionActorRole: role,
    selfApproval: payload.proposedBy.kind === "user" && payload.proposedBy.userId === holder.userId,
    requiredAuthority: required,
    holder,
  };
}
