import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentGovernancePolicies,
  agentStewardships,
  agents,
  companies,
  companyMemberships,
  companySkills,
} from "@paperclipai/db";
import {
  ACCESS_POLICY_REFUSED,
  AGENT_ACCESS_ENFORCEMENT_MODES,
  evaluateAccessV2,
  safeParseAccessPolicy,
  type AgentAccessCheckOutcome,
  type AgentAccessEnforcementMode,
  type AgentAccessPolicy,
  type AgentAccessPolicySideInput,
  type AgentAccessRefusalBody,
  type AgentAccessV2Check,
  type AgentAccessV2Context,
  type AgentAccessV2Dimension,
  type AgentAccessV2Side,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { accessService } from "./access.js";
import { normalizeHumanRole } from "./company-member-roles.js";

/**
 * AgentDash: Agent Performance Management gate 2 — the one server helper every
 * access LLD §4 matrix row calls (gate 2 spec P2.3).
 *
 * Interface frozen in P2.1; implemented in P2.3. Options gained two additive
 * fields (`cache`, `actor`) so a request or a run loads the mode, the stored
 * policy and the live context once.
 *
 * Behaviour by the company's `agent_access_enforcement`:
 * - `off`: returns `allow` without evaluating or logging. One cheap read of
 *   the company row (cached per request/run when a cache is passed).
 * - `shadow`: evaluates `evaluateAccessV2`; on a refusal logs
 *   `access.would_refuse` with `{ dimension, rule, target, site }` and returns
 *   `would_refuse`. Callers MUST NOT change behaviour on `would_refuse`.
 * - `enforce` (gate 3, P3.4): returns `refuse` and logs `authz.refused` with
 *   `{ dimension, rule, policyMode, reasonCode: "ACCESS_POLICY_REFUSED" }`.
 *   Each call site applies its access LLD §4 "On refusal" behaviour; request
 *   paths answer `403 ACCESS_POLICY_REFUSED` through `enforceAgentAccess`.
 *
 * Never widens: callers run the check only where the legacy path has already
 * allowed the action, and treat anything but `refuse` as "continue". MK V1
 * checks run unchanged in every mode. A stored policy that fails to parse is
 * treated as "no V2 restriction" and logged, never as a refusal. The check
 * never throws into its caller: an internal failure is logged and answers
 * `allow`.
 */

/** The matrix rows (access LLD §4) that call `checkAgentAccess`, named for the would-refuse log. */
export const AGENT_ACCESS_CHECK_SITES = [
  "visibility.project_read",
  "heartbeat.run_claim",
  "heartbeat.context_hydration",
  "heartbeat.runtime_skills",
  "export.agent_actor",
  "connectors.resolve_acting_as",
  "connector_send.create",
  "connector_send.execute",
  "agents.skill_sync",
  "agents.hire_skills",
  "import.skills",
  "wake.dispatch",
  "issues.assign",
  "import.assign",
  "handoffs",
  "questions",
  "approval_routing",
  "bridge.task",
] as const;
export type AgentAccessCheckSite = (typeof AGENT_ACCESS_CHECK_SITES)[number];

/** `{ companyId, agentId, dimension, target, via? }` — the agent whose policy is checked, plus the check. */
export type AgentAccessCheckInput = { companyId: string; agentId: string } & AgentAccessV2Check;

/**
 * Per-request (or per-run) memo: the company mode, each agent's stored sides,
 * each agent's live context, and which refusals were already logged in this
 * scope. Never shared across requests, so a mode or roster change is seen by
 * the next request.
 */
export interface AgentAccessCheckCache {
  modes: Map<string, Promise<AgentAccessEnforcementMode>>;
  sides: Map<string, Promise<PolicySides | null>>;
  contexts: Map<string, Promise<AgentAccessV2Context>>;
  requiredSkills: Map<string, Promise<string[]>>;
  logged: Set<string>;
}

export function createAgentAccessCheckCache(): AgentAccessCheckCache {
  return { modes: new Map(), sides: new Map(), contexts: new Map(), requiredSkills: new Map(), logged: new Set() };
}

const scopedCaches = new WeakMap<object, AgentAccessCheckCache>();

/** The cache for one scope object (an Express request, a run's context): created on first use, dropped with it. */
export function agentAccessCheckCacheFor(scope: object): AgentAccessCheckCache {
  let cache = scopedCaches.get(scope);
  if (!cache) {
    cache = createAgentAccessCheckCache();
    scopedCaches.set(scope, cache);
  }
  return cache;
}

export interface AgentAccessCheckOptions {
  /** Which matrix row is asking; recorded on `access.would_refuse`. */
  site?: AgentAccessCheckSite;
  /** A heartbeat run id. Only trusted (server-owned) run ids belong here: it is written to the FK column. */
  runId?: string | null;
  issueId?: string | null;
  /** Context facts the caller already has (e.g. configuration authority for `talk.inbound`); the rest is loaded. */
  context?: Partial<Omit<AgentAccessV2Context, "agentId">>;
  /** AgentDash (P2.3): per-request/run memo. Omitted = no reuse beyond this call. */
  cache?: AgentAccessCheckCache;
  /**
   * AgentDash (P2.3): who attempted the action, for the activity row. Defaults
   * to the checked agent; a `talk.inbound` check defaults to its source.
   */
  actor?: { actorType: "agent" | "user" | "system"; actorId: string };
}

interface PolicySides {
  ceiling: AgentAccessPolicy | null;
  request: AgentAccessPolicy | null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function memo<T>(map: Map<string, Promise<T>> | undefined, key: string, load: () => Promise<T>): Promise<T> {
  if (!map) return load();
  const existing = map.get(key);
  if (existing) return existing;
  const pending = load();
  map.set(key, pending);
  // A failed load is not cached: the next caller retries.
  pending.catch(() => map.delete(key));
  return pending;
}

function asMode(value: unknown): AgentAccessEnforcementMode {
  return (AGENT_ACCESS_ENFORCEMENT_MODES as readonly string[]).includes(value as string)
    ? (value as AgentAccessEnforcementMode)
    : "off";
}

/** `companies.agent_access_enforcement` for the company. Read-only. Unknown company or value → `off`. */
export async function getAgentAccessEnforcementMode(db: Db, companyId: string): Promise<AgentAccessEnforcementMode> {
  const row = await db
    .select({ mode: companies.agentAccessEnforcement })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  return asMode(row?.mode);
}

/** The mode through a cache, so a request asks the company row once. */
export function agentAccessEnforcementModeCached(
  db: Db,
  companyId: string,
  cache?: AgentAccessCheckCache,
): Promise<AgentAccessEnforcementMode> {
  return memo(cache?.modes, companyId, () => getAgentAccessEnforcementMode(db, companyId));
}

function parseSide(raw: unknown, scope: { companyId: string; agentId: string; side: string }): AgentAccessPolicy | null {
  if (raw === null || raw === undefined) return null;
  const parsed = safeParseAccessPolicy(raw);
  if (parsed.success) return parsed.policy;
  // No V2 restriction from an unreadable side; never a refusal.
  logger.warn(
    { companyId: scope.companyId, agentId: scope.agentId, side: scope.side, issues: parsed.error.issues.map((issue) => issue.path) },
    "agent access check: stored policy side is unreadable; treated as no V2 restriction",
  );
  return null;
}

async function loadPolicySides(db: Db, companyId: string, agentId: string): Promise<PolicySides | null> {
  // Company-scoped by both keys: an agent of another company has no row here.
  const row = await db
    .select({ ownerCeiling: agentGovernancePolicies.ownerCeiling, stewardRequest: agentGovernancePolicies.stewardRequest })
    .from(agentGovernancePolicies)
    .where(and(eq(agentGovernancePolicies.companyId, companyId), eq(agentGovernancePolicies.agentId, agentId)))
    .then((rows) => rows[0] ?? null);
  if (!row) return null;
  return {
    ceiling: parseSide(row.ownerCeiling, { companyId, agentId, side: "owner_ceiling" }),
    request: parseSide(row.stewardRequest, { companyId, agentId, side: "steward_request" }),
  };
}

function sidesDefine(sides: PolicySides, dimension: AgentAccessV2Dimension): boolean {
  const [section, field] = dimension.split(".") as ["see" | "do" | "talk", string];
  const has = (policy: AgentAccessPolicy | null) =>
    Boolean(policy && (policy[section] as Record<string, unknown> | undefined)?.[field] !== undefined);
  return has(sides.ceiling) || has(sides.request);
}

const MAX_CHAIN_DEPTH = 64;

/**
 * The live facts `evaluateAccessV2` needs for this agent: its `reportsTo`
 * chain and direct reports, its accountable user, steward and company admins.
 * Read-only; computed per check (or once per request/run through a cache),
 * never stored.
 */
export async function loadAgentAccessV2Context(
  db: Db,
  scope: { companyId: string; agentId: string },
): Promise<AgentAccessV2Context> {
  const { companyId, agentId } = scope;
  const agent = await db
    .select({ id: agents.id, reportsTo: agents.reportsTo, accountableUserId: agents.accountableUserId })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .then((rows) => rows[0] ?? null);

  const managerAgentIds: string[] = [];
  const seen = new Set<string>([agentId]);
  let next = agent?.reportsTo ?? null;
  while (next && !seen.has(next) && managerAgentIds.length < MAX_CHAIN_DEPTH) {
    seen.add(next);
    const manager = await db
      .select({ id: agents.id, reportsTo: agents.reportsTo })
      .from(agents)
      .where(and(eq(agents.id, next), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!manager) break;
    managerAgentIds.push(manager.id);
    next = manager.reportsTo;
  }

  const directReportAgentIds = agent
    ? await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.reportsTo, agentId)))
        .then((rows) => rows.map((row) => row.id).filter((id) => id !== agentId))
    : [];

  const steward = await db
    .select({ userId: agentStewardships.userId })
    .from(agentStewardships)
    .where(
      and(
        eq(agentStewardships.companyId, companyId),
        eq(agentStewardships.agentId, agentId),
        isNull(agentStewardships.endedAt),
      ),
    )
    .then((rows) => rows[0] ?? null);

  const adminUserIds = await db
    .select({ principalId: companyMemberships.principalId, membershipRole: companyMemberships.membershipRole })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
      ),
    )
    .then((rows) => rows.filter((row) => normalizeHumanRole(row.membershipRole) === "admin").map((row) => row.principalId));

  return {
    agentId,
    reportsChain: { managerAgentIds, directReportAgentIds },
    escalation: {
      accountableUserId: agent?.accountableUserId ?? null,
      stewardUserId: steward?.userId ?? null,
      adminUserIds,
    },
  };
}

/** The platform's required skills (bundled Paperclip skills), by key — always allowed by `do.skills`. */
async function loadRequiredSkillKeys(db: Db, companyId: string): Promise<string[]> {
  return db
    .select({ key: companySkills.key })
    .from(companySkills)
    .where(and(eq(companySkills.companyId, companyId), sql`${companySkills.metadata} ->> 'sourceKind' = 'paperclip_bundled'`))
    .then((rows) => rows.map((row) => row.key));
}

/**
 * Does this person hold configuration authority over the agent (access LLD §4
 * invariant: never blocked by the agent's inbound scope)? Admin membership,
 * the agent-administration key, the active steward, the accountable person
 * (who sets the request side for an autonomous agent, access LLD §3.2) or the
 * agent's creator. The escalation contacts are therefore always able to reach
 * the agent, in every mode.
 */
async function userHasConfigurationAuthority(
  db: Db,
  context: AgentAccessV2Context,
  scope: { companyId: string; agentId: string; userId: string },
): Promise<boolean> {
  if (context.escalation.adminUserIds.includes(scope.userId)) return true;
  if (context.escalation.stewardUserId === scope.userId) return true;
  if (context.escalation.accountableUserId === scope.userId) return true;
  const access = accessService(db);
  if (await access.isInstanceAdmin(scope.userId)) return true;
  if (await access.canUser(scope.companyId, scope.userId, "agents:create")) return true;
  const created = await db
    .select({ createdByUserId: agents.createdByUserId })
    .from(agents)
    .where(and(eq(agents.id, scope.agentId), eq(agents.companyId, scope.companyId)))
    .then((rows) => rows[0] ?? null);
  return created?.createdByUserId === scope.userId;
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/** The rule's part after its dimension (`see.projects.not_listed` → `not_listed`). */
function ruleReason(dimension: AgentAccessV2Dimension, rule: string): string {
  return rule.startsWith(`${dimension}.`) ? rule.slice(dimension.length + 1) : rule;
}

/**
 * The rule as written to the activity log: `<dimension>:<reason>`. The
 * canonical `see.projects.not_listed` has three dot-separated segments, which
 * the activity redaction treats as a JWT and replaces; the colon form survives
 * it. `dimension + "." + reason` is the canonical rule.
 */
export function loggedRule(dimension: AgentAccessV2Dimension, rule: string): string {
  return `${dimension}:${ruleReason(dimension, rule)}`;
}

function checkOf(input: AgentAccessCheckInput): AgentAccessV2Check {
  const { companyId: _companyId, agentId: _agentId, ...check } = input;
  return check as AgentAccessV2Check;
}

function defaultActor(input: AgentAccessCheckInput): { actorType: "agent" | "user" | "system"; actorId: string } {
  if (input.dimension === "talk.inbound") {
    return input.target.kind === "agent"
      ? { actorType: "agent", actorId: input.target.agentId }
      : { actorType: "user", actorId: input.target.userId };
  }
  return { actorType: "agent", actorId: input.agentId };
}

/**
 * What one check concluded, with the refusal it would answer. `refusal` is set
 * for `refuse` and `would_refuse` (the body a shadow refusal WOULD have sent),
 * null for `allow`. `mode` is the company's mode the check ran under.
 */
export interface AgentAccessCheckResult {
  outcome: AgentAccessCheckOutcome;
  mode: AgentAccessEnforcementMode;
  refusal: AgentAccessRefusalBody | null;
}

const ALLOW_RESULT_OFF: AgentAccessCheckResult = Object.freeze({ outcome: "allow", mode: "off", refusal: null }) as AgentAccessCheckResult;

/**
 * The `howToRequest` line of a refusal body (access LLD §4, §9), by the side
 * that refused. Plain language, adapter-neutral; names the read-only self view
 * and the always-reachable people.
 */
export function howToRequestFor(side: AgentAccessV2Side): string {
  const selfView = "Read your rules at GET /api/agents/me/access; your accountable person, steward and company admins are always reachable.";
  switch (side) {
    case "ceiling":
      return `A company admin's ceiling for this agent does not allow it; only an admin can raise the ceiling. Record the blocker on the issue for your accountable person or steward. ${selfView}`;
    case "request":
      return `Ask your accountable person or steward to change this agent's access: propose a profile change (POST /api/companies/:companyId/agents/:agentId/profile/revisions, then propose it) or record the blocker on the issue. ${selfView}`;
    case "fixed":
      return `This is a fixed rule that no profile change lifts. Record the blocker on the issue for your accountable person or steward. ${selfView}`;
  }
}

/** The refusal body (`403 ACCESS_POLICY_REFUSED`) for a refused check. */
function refusalBody(
  check: AgentAccessV2Check,
  decision: Extract<ReturnType<typeof evaluateAccessV2>, { decision: "refuse" }>,
): AgentAccessRefusalBody {
  const via = "via" in check ? check.via : undefined;
  return {
    code: ACCESS_POLICY_REFUSED,
    dimension: decision.dimension,
    rule: decision.rule,
    requested: { ...(check.target as Record<string, unknown>), ...(via ? { via } : {}) },
    allowedSummary: decision.allowedSummary,
    howToRequest: howToRequestFor(decision.side),
  };
}

/**
 * Evaluate one V2 access check for one agent under the company's mode, with
 * the refusal body. Company-scoped: the agent's stored policy is read by
 * `(companyId, agentId)`. Never throws; an internal failure answers `allow`.
 */
export async function checkAgentAccessDetailed(
  db: Db,
  input: AgentAccessCheckInput,
  options: AgentAccessCheckOptions = {},
): Promise<AgentAccessCheckResult> {
  const cache = options.cache;
  try {
    const mode = await agentAccessEnforcementModeCached(db, input.companyId, cache);
    if (mode === "off") return ALLOW_RESULT_OFF;
    const allow: AgentAccessCheckResult = { outcome: "allow", mode, refusal: null };

    const stored = await memo(cache?.sides, `${input.companyId}:${input.agentId}`, () =>
      loadPolicySides(db, input.companyId, input.agentId),
    );
    // A fixed rule holds with or without a stored policy: an agent-authored
    // bridge task runs only on its steward's or accountable person's machine
    // (access LLD §4, talk.people row: "bridge: steward/accountable only, always").
    const fixedRule = input.dimension === "talk.people" && input.target.purpose === "bridge_task";
    // Otherwise, no stored policy, or neither side restricts this dimension:
    // V2 says nothing, and the live context is never loaded.
    if (!fixedRule && (!stored || !sidesDefine(stored, input.dimension))) return allow;
    const sides: PolicySides = stored ?? { ceiling: null, request: null };

    const loaded = await memo(cache?.contexts, `${input.companyId}:${input.agentId}`, () =>
      loadAgentAccessV2Context(db, { companyId: input.companyId, agentId: input.agentId }),
    );
    const context: AgentAccessV2Context = { ...loaded, ...(options.context ?? {}), agentId: input.agentId };
    if (input.dimension === "do.skills" && options.context?.requiredSkillKeys === undefined) {
      context.requiredSkillKeys = await memo(cache?.requiredSkills, input.companyId, () => loadRequiredSkillKeys(db, input.companyId));
    }
    if (
      input.dimension === "talk.inbound" &&
      input.target.kind === "user" &&
      options.context?.sourceHasConfigurationAuthority === undefined
    ) {
      context.sourceHasConfigurationAuthority = await userHasConfigurationAuthority(db, context, {
        companyId: input.companyId,
        agentId: input.agentId,
        userId: input.target.userId,
      });
    }

    const check = checkOf(input);
    const decision = evaluateAccessV2(
      sides.ceiling as AgentAccessPolicySideInput,
      sides.request as AgentAccessPolicySideInput,
      check,
      context,
    );
    if (decision.decision === "allow") return allow;

    const outcome: AgentAccessCheckOutcome = mode === "enforce" ? "refuse" : "would_refuse";
    const via = "via" in check ? check.via : undefined;
    const site = options.site ?? null;
    const dedupeKey = JSON.stringify([site, input.agentId, input.dimension, check.target, via ?? null]);
    if (!cache || !cache.logged.has(dedupeKey)) {
      cache?.logged.add(dedupeKey);
      const actor = options.actor ?? defaultActor(input);
      try {
        await logActivity(db, {
          companyId: input.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          // Gate 3 records an enforced refusal as `authz.refused` (access LLD §4).
          action: mode === "enforce" ? "authz.refused" : "access.would_refuse",
          entityType: "agent",
          entityId: input.agentId,
          agentId: input.agentId,
          runId: options.runId ?? null,
          details: {
            // AgentDash (P3.4): refusal tallies key `authz.refused` by its reasonCode.
            ...(mode === "enforce" ? { reasonCode: ACCESS_POLICY_REFUSED } : {}),
            dimension: decision.dimension,
            rule: loggedRule(decision.dimension, decision.rule),
            reason: ruleReason(decision.dimension, decision.rule),
            target: check.target,
            site,
            ...(via ? { via } : {}),
            side: decision.side,
            allowedSummary: decision.allowedSummary,
            policyMode: mode,
            ...(options.issueId ? { issueId: options.issueId } : {}),
          },
        });
      } catch (error) {
        cache?.logged.delete(dedupeKey);
        logger.warn(
          { err: error, companyId: input.companyId, agentId: input.agentId, dimension: input.dimension, site },
          "agent access check: failed to record a refusal",
        );
      }
    }
    return { outcome, mode, refusal: refusalBody(check, decision) };
  } catch (error) {
    logger.warn(
      { err: error, companyId: input.companyId, agentId: input.agentId, dimension: input.dimension, site: options.site ?? null },
      "agent access check failed; continuing without a V2 decision",
    );
    return { outcome: "allow", mode: "off", refusal: null };
  }
}

/** `checkAgentAccessDetailed`, answering only the outcome. Never throws. */
export async function checkAgentAccess(
  db: Db,
  input: AgentAccessCheckInput,
  options: AgentAccessCheckOptions = {},
): Promise<AgentAccessCheckOutcome> {
  return (await checkAgentAccessDetailed(db, input, options)).outcome;
}

/**
 * Run several checks for one action and answer the most restrictive outcome
 * (`refuse` > `would_refuse` > `allow`) with the first refusal of that rank.
 * Every check runs, so each refusal is logged. Never throws.
 */
export async function checkAgentAccessAllDetailed(
  db: Db,
  inputs: AgentAccessCheckInput[],
  options: AgentAccessCheckOptions = {},
): Promise<AgentAccessCheckResult> {
  const cache = options.cache ?? createAgentAccessCheckCache();
  let worst: AgentAccessCheckResult = { outcome: "allow", mode: "off", refusal: null };
  for (const input of inputs) {
    const result = await checkAgentAccessDetailed(db, input, { ...options, cache });
    if (result.mode !== "off" && worst.mode === "off") worst = { ...worst, mode: result.mode };
    if (result.outcome === "refuse" && worst.outcome !== "refuse") worst = result;
    else if (result.outcome === "would_refuse" && worst.outcome === "allow") worst = result;
  }
  return worst;
}

/** `checkAgentAccessAllDetailed`, answering only the outcome. Never throws. */
export async function checkAgentAccessAll(
  db: Db,
  inputs: AgentAccessCheckInput[],
  options: AgentAccessCheckOptions = {},
): Promise<AgentAccessCheckOutcome> {
  return (await checkAgentAccessAllDetailed(db, inputs, options)).outcome;
}

// ---------------------------------------------------------------------------
// Enforcement (gate 3, P3.4): the request-path refusal
// ---------------------------------------------------------------------------

/**
 * `403 ACCESS_POLICY_REFUSED`. The response body is the refusal itself at the
 * top level (`{ error, code, dimension, rule, requested, allowedSummary,
 * howToRequest }`, access LLD §4); the error handler spreads it.
 */
export class AccessPolicyRefusedError extends HttpError {
  readonly refusal: AgentAccessRefusalBody;
  constructor(refusal: AgentAccessRefusalBody) {
    super(403, accessPolicyRefusedMessage(refusal), refusal, ACCESS_POLICY_REFUSED);
    this.refusal = refusal;
  }
}

/** The plain-language `error` line of a refusal. */
export function accessPolicyRefusedMessage(refusal: Pick<AgentAccessRefusalBody, "dimension" | "allowedSummary">): string {
  return `Refused by this agent's access rules (${refusal.dimension}). Allowed: ${refusal.allowedSummary}.`;
}

/** The full JSON body of a `403 ACCESS_POLICY_REFUSED` (for routes that answer it themselves). */
export function accessPolicyRefusedResponse(refusal: AgentAccessRefusalBody): Record<string, unknown> & { error: string } {
  return { error: accessPolicyRefusedMessage(refusal), ...refusal };
}

/**
 * The check for a request path: in `enforce` a refusal throws
 * `AccessPolicyRefusedError` (403) after logging `authz.refused`; in `shadow`
 * a would-be refusal is logged and the caller continues; `off` does nothing.
 * Never throws for any other reason.
 */
export async function enforceAgentAccess(
  db: Db,
  input: AgentAccessCheckInput,
  options: AgentAccessCheckOptions = {},
): Promise<AgentAccessCheckResult> {
  const result = await checkAgentAccessDetailed(db, input, options);
  if (result.outcome === "refuse" && result.refusal) throw new AccessPolicyRefusedError(result.refusal);
  return result;
}

/** `enforceAgentAccess` over several checks (every check runs and logs; the first refusal throws). */
export async function enforceAgentAccessAll(
  db: Db,
  inputs: AgentAccessCheckInput[],
  options: AgentAccessCheckOptions = {},
): Promise<AgentAccessCheckResult> {
  const result = await checkAgentAccessAllDetailed(db, inputs, options);
  if (result.outcome === "refuse" && result.refusal) throw new AccessPolicyRefusedError(result.refusal);
  return result;
}

/**
 * The enforce-mode-only form, for request paths whose gate 2 shadow check runs
 * AFTER the side effect (so a refusal must be raised before it): nothing is
 * evaluated or logged unless the company's mode is `enforce`, which keeps
 * off/shadow exactly as gate 2. Throws `AccessPolicyRefusedError` on refusal.
 */
export async function enforceAgentAccessBeforeEffect(
  db: Db,
  input: AgentAccessCheckInput,
  options: AgentAccessCheckOptions = {},
): Promise<void> {
  let mode: AgentAccessEnforcementMode = "off";
  try {
    mode = await agentAccessEnforcementModeCached(db, input.companyId, options.cache);
  } catch (error) {
    logger.warn({ err: error, companyId: input.companyId }, "agent access mode read failed; not enforcing");
    return;
  }
  if (mode !== "enforce") return;
  await enforceAgentAccess(db, input, options);
}

/**
 * The project ids an agent may see under its V2 `see.projects` scope, when the
 * company enforces and either side lists projects: the intersection of the
 * listed sides (the same rule `evaluateAccessV2` applies per project). `null`
 * = no V2 project restriction (mode off/shadow, no stored policy, or both
 * sides `all`). Issues with no project are never restricted by it.
 * Read-only. Never throws (an internal failure answers `null`).
 */
export async function loadEnforcedAgentProjectScope(
  db: Pick<Db, "select">,
  scope: { companyId: string; agentId: string },
  cache?: AgentAccessCheckCache,
): Promise<ReadonlySet<string> | null> {
  try {
    const fullDb = db as Db;
    if ((await agentAccessEnforcementModeCached(fullDb, scope.companyId, cache)) !== "enforce") return null;
    const stored = await memo(cache?.sides, `${scope.companyId}:${scope.agentId}`, () =>
      loadPolicySides(fullDb, scope.companyId, scope.agentId),
    );
    if (!stored) return null;
    let allowed: Set<string> | null = null;
    for (const side of [stored.ceiling, stored.request]) {
      const projects = side?.see?.projects;
      if (!projects || projects.mode === "all") continue;
      const ids = new Set<string>(projects.ids);
      const previous: Set<string> | null = allowed;
      allowed = previous === null ? ids : new Set<string>([...previous].filter((id: string) => ids.has(id)));
    }
    return allowed;
  } catch (error) {
    logger.warn({ err: error, ...scope }, "agent access: project scope not loaded; no V2 list filter");
    return null;
  }
}

// ---------------------------------------------------------------------------
// connector_send (access LLD §3.2 send precedence, §4 do.connections + talk.external)
// ---------------------------------------------------------------------------

/** Record fields that name an external party a CRM write reaches. */
const EXTERNAL_TARGET_FIELDS = ["email", "domain", "website"] as const;

/** The external targets (addresses, domains, URLs) a connector write names. Values only from known fields. */
export function connectorSendExternalTargets(properties: Record<string, unknown> | null | undefined): string[] {
  if (!properties || typeof properties !== "object") return [];
  const out = new Set<string>();
  for (const field of EXTERNAL_TARGET_FIELDS) {
    const value = properties[field];
    if (typeof value === "string" && value.trim().length > 0) out.add(value.trim());
  }
  return [...out];
}

/**
 * The V2 checks for one `connector_send`: the connection's `send` mode on the
 * approval path (rule 1 of the precedence table — the provider always files
 * an approval — so V2 can only add "never"), and every external target the
 * write names. Shadow and enforce share these inputs.
 */
export function connectorSendAccessChecks(input: {
  companyId: string;
  agentId: string;
  connectionId: string;
  properties?: Record<string, unknown> | null;
}): { inputs: AgentAccessCheckInput[]; context: Partial<Omit<AgentAccessV2Context, "agentId">> } {
  const inputs: AgentAccessCheckInput[] = [
    {
      companyId: input.companyId,
      agentId: input.agentId,
      dimension: "do.connections",
      target: { connectionId: input.connectionId, actionClass: "send", onApprovalPath: true },
    },
    ...connectorSendExternalTargets(input.properties).map(
      (externalTarget): AgentAccessCheckInput => ({
        companyId: input.companyId,
        agentId: input.agentId,
        dimension: "talk.external",
        target: { connectionId: input.connectionId, externalTarget },
      }),
    ),
  ];
  return { inputs, context: { legacySendRequirement: "approve" } };
}
