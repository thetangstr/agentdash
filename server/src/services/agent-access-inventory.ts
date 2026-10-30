// AgentDash: Agent Performance Management gate 1 — the access inventory.
//
// What one agent can see, do, talk to and spend TODAY, computed on read from
// the mechanisms that already exist. Nothing here grants, narrows or stores
// anything: the loader only selects, and the builder is a pure function of
// what the loader read. Where today's records cannot answer a question the
// answer is null or "unknown", never a guessed value.
//
// Design: doc/plans/2026-10-29-agent-access-lld.md §2 (the map of today's
// mechanisms), §3.3 (the five states), §6 (the host boundary).
import { and, eq, gte, inArray, isNull, lt, lte, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  authUsers,
  budgetPolicies,
  companies,
  companyMemberships,
  companySkills,
  connections,
  costEvents,
  environments,
  mandates,
  principalPermissionGrants,
  projectAccess,
  projects,
} from "@paperclipai/db";
import {
  ACCESS_POLICY_REFUSED,
  AGENT_POLICY_UNLIMITED_BUDGET_CENTS,
  AGENT_POLICY_WILDCARD,
  evaluateAccessV2,
  isDocumentProvider,
  policyListAllows,
  safeParseAccessPolicy,
  type ActingAsResult,
  type AgentAccessContactScope,
  type AgentAccessEnforcementMode,
  type AgentAccessPolicy,
  type AgentAccessEnforcedSummary,
  type AgentAccessShadowSummary,
  type AgentAccessV2Check,
  type AgentAccessV2Context,
  type AgentAccessGap,
  type AgentAccessInventory,
  type AgentAccessItem,
  type AgentGovernancePolicy,
  type AgentHostEnvironment,
  type ConnectorActionClass,
} from "@paperclipai/shared";
import { accessService } from "./access.js";
import { agentAccountabilityService, type AgentAccountability } from "./agent-accountability.js";
import { UNRESTRICTED_PROJECT_SCOPE, type ViewerProjectScope } from "./agent-performance-authz.js";
import { loadAgentRefusalCounts, tallyRefusals, type AgentRefusalCount } from "./agent-performance-projection.js";
import { agentGovernanceService } from "./agent-governance.js";
import { agentHandoffsEnabled } from "./agent-handoffs.js";
import { normalizeAgentPermissions } from "./agent-permissions.js";
import { agentStewardshipService } from "./agent-stewardships.js";
import { normalizeHumanRole } from "./company-member-roles.js";
import { connectorService } from "./connectors.js";
import { getAgentAccessEnforcementMode, loadAgentAccessV2Context } from "./agent-access-check.js";
import { loadActiveProfileBlockRevision } from "./agent-profile-block.js";

export const AGENT_ACCESS_DEFAULT_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The observation window `[asOf − days, asOf]`. */
export function agentAccessWindow(asOf: Date, days: number): { from: Date; to: Date } {
  return { from: new Date(asOf.getTime() - days * DAY_MS), to: asOf };
}
const RUN_CONTEXT_NOTE = "API reads only; run context and export are not checked";
/** Shown on `see.projects.open` when the viewer's restricted-project rule applied. */
export const RESTRICTED_PROJECTS_WITHHELD_NOTE = "Restricted projects you can't see are not listed";

/**
 * Permission keys some route checks for an AGENT principal (`hasPermission`
 * with principal type "agent"): issues.ts (tasks:assign,
 * tasks:manage_active_checkouts), agents.ts and company-skills.ts
 * (agents:create), environments.ts (environments:manage), access.ts
 * (users:invite, joins:approve, users:manage_permissions). A grant of any other
 * key to an agent is stored but no check reads it for an agent caller.
 */
const AGENT_CHECKED_PERMISSION_KEYS: ReadonlySet<string> = new Set([
  "agents:create",
  "environments:manage",
  "joins:approve",
  "tasks:assign",
  "tasks:manage_active_checkouts",
  "users:invite",
  "users:manage_permissions",
]);

/** The same words the Company Access page uses for these keys (ui/src/pages/CompanyAccess.tsx). */
const PERMISSION_LABELS: Record<string, string> = {
  "agents:create": "Create agents",
  "projects:create": "Create projects",
  "users:invite": "Invite humans and agents",
  "users:manage_permissions": "Manage members and grants",
  "tasks:assign": "Assign tasks",
  "tasks:assign_scope": "Assign scoped tasks",
  "tasks:manage_active_checkouts": "Manage active task checkouts",
  "joins:approve": "Approve join requests",
  "environments:manage": "Manage environments",
};

/** Activity actions the builder maps to an item. Everything else is not counted as an item's use. */
export const AGENT_ACCESS_MAPPED_ACTIONS = [
  "agent.skills_synced",
  "agent.updated",
  "issue.thread_interaction_created",
  "connection.hubspot_write_requested",
  "issue.agent_handoff",
  "issue.agent_handoff_returned",
  "issue.agent_handoff_refused",
  "authz.refused",
] as const;

// ---------------------------------------------------------------------------
// Loader input
// ---------------------------------------------------------------------------

type ConnectionResolutions = Record<ConnectorActionClass, ActingAsResult>;

export interface AgentAccessConnectionInput {
  id: string;
  provider: string;
  ownerType: string;
  ownerId: string;
  visibility: string;
  status: string;
  accountLabel: string | null;
  hasToken: boolean;
  autonomy: Partial<Record<ConnectorActionClass, string>>;
  /** Why the agent's resolution rule reaches this row (connectors.ts resolveActingAs). */
  via: "own" | "workspace" | "steward_document" | "steward_fallback";
  /** `resolveActingAs` naming this connection, per action class. Null when the row is not active. */
  resolutions: ConnectionResolutions | null;
}

export interface AgentAccessActivityRow {
  action: string;
  entityId: string;
  interactionKind: string | null;
  reasonCode: string | null;
  capabilitiesChanged: boolean;
  count: number;
  lastAt: Date | null;
}

export interface AgentAccessInventoryInput {
  generatedAt: Date;
  window: { from: Date; to: Date };
  company: { id: string; productProfile: string; agentVisibilityDefault: string };
  agent: {
    id: string;
    name: string;
    role: string;
    status: string;
    pauseReason: string | null;
    adapterType: string;
    adapterConfig: Record<string, unknown>;
    /** Raw `agents.permissions`, before role defaults. */
    permissions: Record<string, unknown> | null;
    defaultEnvironmentId: string | null;
    visibility: string | null;
    budgetMonthlyCents: number;
  };
  environment: { id: string; name: string; driver: string; status: string } | null;
  membershipStatus: string | null;
  grants: Array<{ permissionKey: string; scope: Record<string, unknown> | null }>;
  projects: Array<{
    id: string;
    name: string;
    visibility: string;
    archived: boolean;
    leadAgentId: string | null;
    onAccessList: boolean;
  }>;
  steward: { userId: string; name: string | null } | null;
  accountability: Pick<AgentAccountability, "autonomy" | "userId" | "via"> & { name: string | null } | null;
  admins: Array<{ userId: string; name: string | null }>;
  activeMemberCount: number;
  peers: Array<{ id: string; status: string; role: string; canCreateAgents: boolean; hasTaskAssignGrant: boolean }>;
  companySkillCount: number;
  governance: { onProfile: boolean; effectivePolicy: AgentGovernancePolicy | null };
  connections: AgentAccessConnectionInput[];
  connectorDefaults: Record<ConnectorActionClass, string>;
  agentConnectorOverride: Partial<Record<ConnectorActionClass, string>> | null;
  mandates: Array<{
    id: string;
    grantorAgentId: string;
    grantorName: string | null;
    scope: string[];
    permissionKey: string;
    spendCapCents: number;
    expiresAt: Date;
  }>;
  budget: {
    policy: { amount: number; windowKind: string; hardStopEnabled: boolean } | null;
    observedCents: number;
  };
  handoffsEnabled: boolean;
  activity: AgentAccessActivityRow[];
  /** AgentDash (APM gate 1): refused attempts in the window, counted by the projection's rule (`tallyRefusals`). */
  refusalCounts: AgentRefusalCount[];
  /**
   * True when the viewer's restricted-project rule was applied: restricted
   * projects the viewer can't read were left out of `projects` before building.
   */
  projectsWithheld: boolean;
  /**
   * AgentDash (APM gate 2, P2.3): the agent's ACTIVE operating-profile
   * revision and the access it requests. Null/omitted = no profile applied
   * (every item then reads Requested "not_defined", as in gate 1).
   */
  profile?: { activeRevisionId: string; access: AgentAccessPolicy } | null;
  /** AgentDash (APM gate 2): `companies.agent_access_enforcement`; omitted = `off`. */
  enforcementMode?: AgentAccessEnforcementMode;
  /**
   * AgentDash (APM gate 2): the stored governance sides read as V2 (any
   * company — profile application writes the request side everywhere) and the
   * live context their contact predicates need. Omitted = no V2 policy.
   */
  accessPolicy?: { ceiling: AgentAccessPolicy | null; request: AgentAccessPolicy | null; context: AgentAccessV2Context } | null;
  /**
   * AgentDash (APM gate 2): `access.would_refuse` rows for this agent in the
   * window, newest first, already filtered by the viewer's project rule and
   * labelled. Omitted = none.
   */
  wouldRefuse?: AgentAccessWouldRefuseRow[];
  /**
   * AgentDash (APM gate 3, P3.7): `authz.refused` rows with
   * `ACCESS_POLICY_REFUSED` (what V2 refused under `enforce`) for this agent in
   * the window, newest first, filtered and labelled like `wouldRefuse`.
   * Omitted = none.
   */
  enforcedRefusals?: AgentAccessWouldRefuseRow[];
}

export interface AgentAccessWouldRefuseRow {
  at: Date;
  dimension: string;
  rule: string | null;
  site: string | null;
  targetLabel: string | null;
}

/** Bound on the would-be refusals read per inventory (the counts cover at most this many). */
export const AGENT_ACCESS_WOULD_REFUSE_ROW_CAP = 5000;
const SHADOW_RECENT_LIMIT = 20;

// ---------------------------------------------------------------------------
// Loader — reads only
// ---------------------------------------------------------------------------

export interface LoadAgentAccessInventoryOptions {
  companyId: string;
  agentId: string;
  asOf?: Date;
  windowDays?: number;
  /** The viewer's restricted-project rule (`viewerProjectScope`); unrestricted when omitted. */
  viewer?: ViewerProjectScope;
}

/**
 * Gather every row the inventory is built from. Returns null when the agent
 * does not exist in this company, so a cross-company id reads as nonexistent.
 *
 * Every helper called here is a plain select: `getForAgent` reports a
 * synthetic default rather than inserting, and `resolveActingAs` decides
 * without logging. Anything that writes (activity, approvals, token refresh)
 * is deliberately not called.
 */
export async function loadAgentAccessInventoryInput(
  db: Db,
  options: LoadAgentAccessInventoryOptions,
): Promise<AgentAccessInventoryInput | null> {
  const { companyId, agentId } = options;
  const viewer = options.viewer ?? UNRESTRICTED_PROJECT_SCOPE;
  const generatedAt = options.asOf ?? new Date();
  const window = agentAccessWindow(generatedAt, options.windowDays ?? AGENT_ACCESS_DEFAULT_WINDOW_DAYS);

  const company = await db
    .select({
      id: companies.id,
      productProfile: companies.productProfile,
      agentVisibilityDefault: companies.agentVisibilityDefault,
    })
    .from(companies)
    .where(eq(companies.id, companyId))
    .then((rows) => rows[0] ?? null);
  if (!company) return null;

  const agent = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!agent) return null;

  const access = accessService(db);
  const stewardships = agentStewardshipService(db);
  const governance = agentGovernanceService(db);
  const connectorsSvc = connectorService(db);

  const environment = agent.defaultEnvironmentId
    ? await db
        .select({ id: environments.id, name: environments.name, driver: environments.driver, status: environments.status })
        .from(environments)
        .where(and(eq(environments.id, agent.defaultEnvironmentId), eq(environments.companyId, companyId)))
        .then((rows) => rows[0] ?? null)
    : null;

  const membership = await access.getMembership(companyId, "agent", agentId);
  const grants = await access.listPrincipalGrants(companyId, "agent", agentId);

  const projectRows = await db
    .select({
      id: projects.id,
      name: projects.name,
      visibility: projects.visibility,
      archivedAt: projects.archivedAt,
      leadAgentId: projects.leadAgentId,
    })
    .from(projects)
    // AgentDash (APM gate 1): a restricted project the VIEWER can't read is
    // nonexistent here, as everywhere (A5): no title, no id, no count.
    .where(and(eq(projects.companyId, companyId), viewer.projects));
  const listedProjectIds = new Set(
    await db
      .select({ projectId: projectAccess.projectId })
      .from(projectAccess)
      .innerJoin(projects, eq(projects.id, projectAccess.projectId))
      .where(
        and(
          eq(projects.companyId, companyId),
          eq(projectAccess.principalType, "agent"),
          eq(projectAccess.principalId, agentId),
        ),
      )
      .then((rows) => rows.map((row) => row.projectId)),
  );

  const stewardRow = await stewardships.activeByAgent(companyId, agentId);
  const accountability = await agentAccountabilityService(db).resolveForAgent(companyId, agentId);

  const memberRows = await db
    .select({ principalId: companyMemberships.principalId, membershipRole: companyMemberships.membershipRole })
    .from(companyMemberships)
    .where(
      and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
      ),
    );
  const adminIds = memberRows
    .filter((row) => normalizeHumanRole(row.membershipRole) === "admin")
    .map((row) => row.principalId);

  // Names only. Member emails are never returned to agent callers (GH #505),
  // and `/agents/me/access` is an agent read.
  const nameIds = [...new Set([stewardRow?.userId, accountability?.userId, ...adminIds].filter((id): id is string => Boolean(id)))];
  const names = new Map<string, string | null>();
  if (nameIds.length > 0) {
    const users = await db
      .select({ id: authUsers.id, name: authUsers.name })
      .from(authUsers)
      .where(inArray(authUsers.id, nameIds));
    for (const user of users) names.set(user.id, user.name?.trim() || null);
  }

  const peerRows = await db
    .select({ id: agents.id, status: agents.status, role: agents.role, permissions: agents.permissions })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), ne(agents.id, agentId)));
  const activeAgentMembers = new Set(
    await db
      .select({ principalId: companyMemberships.principalId })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "agent"),
          eq(companyMemberships.status, "active"),
        ),
      )
      .then((rows) => rows.map((row) => row.principalId)),
  );
  const taskAssignGrantees = new Set(
    await db
      .select({ principalId: principalPermissionGrants.principalId })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalType, "agent"),
          eq(principalPermissionGrants.permissionKey, "tasks:assign"),
        ),
      )
      .then((rows) => rows.map((row) => row.principalId)),
  );

  const companySkillCount = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(companySkills)
    .where(eq(companySkills.companyId, companyId))
    .then((rows) => Number(rows[0]?.n ?? 0));

  const onProfile = company.productProfile === "agentdash_mk";
  const effectivePolicy = onProfile ? await governance.resolveAgentPolicy(companyId, agentId) : null;

  const connectionList = await loadConnections(db, connectorsSvc, {
    companyId,
    agentId,
    onProfile,
    stewardUserId: stewardRow?.userId ?? null,
  });
  const defaults = await connectorsSvc.getWorkspaceDefaults(companyId);
  const override = await connectorsSvc.getAgentOverrides(companyId, agentId);

  const mandateRows = await db
    .select({
      id: mandates.id,
      grantorAgentId: mandates.grantorAgentId,
      scope: mandates.scope,
      permissionKey: mandates.permissionKey,
      spendCapCents: mandates.spendCapCents,
      expiresAt: mandates.expiresAt,
    })
    .from(mandates)
    .where(
      and(
        eq(mandates.companyId, companyId),
        eq(mandates.granteeAgentId, agentId),
        eq(mandates.status, "active"),
        gte(mandates.expiresAt, generatedAt),
      ),
    );
  const grantorNames = new Map<string, string>();
  const grantorIds = [...new Set(mandateRows.map((row) => row.grantorAgentId))];
  if (grantorIds.length > 0) {
    const grantors = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.companyId, companyId), inArray(agents.id, grantorIds)));
    for (const grantor of grantors) grantorNames.set(grantor.id, grantor.name);
  }

  const budgetPolicy = await db
    .select({ amount: budgetPolicies.amount, windowKind: budgetPolicies.windowKind, hardStopEnabled: budgetPolicies.hardStopEnabled })
    .from(budgetPolicies)
    .where(
      and(
        eq(budgetPolicies.companyId, companyId),
        eq(budgetPolicies.scopeType, "agent"),
        eq(budgetPolicies.scopeId, agentId),
        eq(budgetPolicies.isActive, true),
        eq(budgetPolicies.metric, "billed_cents"),
      ),
    )
    .then((rows) => rows[0] ?? null);
  const observedCents = await observedAgentSpend(db, companyId, agentId, budgetPolicy?.windowKind ?? "calendar_month_utc", generatedAt);

  const activity = await loadMappedActivity(db, companyId, agentId, window);

  // AgentDash (APM gate 2, P2.3): Requested from the active profile revision,
  // Defined V2 from the stored sides, and the company's enforcement mode.
  const activeRevision = await loadActiveProfileBlockRevision(db, { id: agentId, companyId });
  const enforcementMode = await getAgentAccessEnforcementMode(db, companyId);
  const storedSides = await governance.getForAgent(companyId, agentId);
  const parseSide = (value: unknown) => {
    const parsed = safeParseAccessPolicy(value);
    return parsed.success ? parsed.policy : null;
  };
  const ceilingSide = storedSides.id ? parseSide(storedSides.ownerCeiling) : null;
  const requestSide = storedSides.id ? parseSide(storedSides.stewardRequest) : null;
  const accessPolicy =
    ceilingSide || requestSide
      ? { ceiling: ceilingSide, request: requestSide, context: await loadAgentAccessV2Context(db, { companyId, agentId }) }
      : null;
  const wouldRefuse = enforcementMode === "off" ? [] : await loadWouldRefuseRows(db, { companyId, agentId, window, viewer, connections: connectionList });
  const enforcedRefusals =
    enforcementMode === "off" ? [] : await loadWouldRefuseRows(db, { companyId, agentId, window, viewer, connections: connectionList, kind: "enforced" });

  return {
    generatedAt,
    window,
    company: {
      id: company.id,
      productProfile: company.productProfile,
      agentVisibilityDefault: company.agentVisibilityDefault,
    },
    agent: {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      status: agent.status,
      pauseReason: agent.pauseReason,
      adapterType: agent.adapterType,
      adapterConfig: agent.adapterConfig ?? {},
      permissions: agent.permissions ?? null,
      defaultEnvironmentId: agent.defaultEnvironmentId,
      visibility: agent.visibility,
      budgetMonthlyCents: agent.budgetMonthlyCents,
    },
    environment,
    membershipStatus: membership?.status ?? null,
    grants: grants.map((grant) => ({
      permissionKey: grant.permissionKey,
      scope: (grant.scope as Record<string, unknown> | null) ?? null,
    })),
    projects: projectRows.map((row) => ({
      id: row.id,
      name: row.name,
      visibility: row.visibility,
      archived: row.archivedAt != null,
      leadAgentId: row.leadAgentId,
      onAccessList: listedProjectIds.has(row.id),
    })),
    steward: stewardRow ? { userId: stewardRow.userId, name: names.get(stewardRow.userId) ?? null } : null,
    accountability: accountability
      ? {
          autonomy: accountability.autonomy,
          userId: accountability.userId,
          via: accountability.via,
          name: accountability.userId ? names.get(accountability.userId) ?? null : null,
        }
      : null,
    admins: adminIds.map((userId) => ({ userId, name: names.get(userId) ?? null })),
    activeMemberCount: memberRows.length,
    peers: peerRows.map((row) => ({
      id: row.id,
      status: row.status,
      role: row.role,
      canCreateAgents: normalizeAgentPermissions(row.permissions, row.role).canCreateAgents,
      hasTaskAssignGrant: activeAgentMembers.has(row.id) && taskAssignGrantees.has(row.id),
    })),
    companySkillCount,
    governance: { onProfile, effectivePolicy },
    connections: connectionList,
    connectorDefaults: {
      read: defaults.autonomy.read,
      draft: defaults.autonomy.draft,
      send: defaults.autonomy.send,
    },
    agentConnectorOverride: (override?.autonomy as Partial<Record<ConnectorActionClass, string>> | undefined) ?? null,
    mandates: mandateRows.map((row) => ({
      id: row.id,
      grantorAgentId: row.grantorAgentId,
      grantorName: grantorNames.get(row.grantorAgentId) ?? null,
      scope: Array.isArray(row.scope) ? row.scope : [],
      permissionKey: row.permissionKey,
      spendCapCents: row.spendCapCents,
      expiresAt: row.expiresAt,
    })),
    budget: { policy: budgetPolicy, observedCents },
    handoffsEnabled: await agentHandoffsEnabled(db, companyId),
    activity,
    refusalCounts: await loadAgentRefusalCounts(db, companyId, agentId, window),
    projectsWithheld: viewer.restricted,
    profile: activeRevision ? { activeRevisionId: activeRevision.id, access: activeRevision.body.access as AgentAccessPolicy } : null,
    enforcementMode,
    accessPolicy,
    wouldRefuse,
    enforcedRefusals,
  };
}

/**
 * AgentDash (APM gate 2): this agent's `access.would_refuse` rows in the
 * window, newest first. A row naming a project the viewer can't see is left
 * out entirely (as nonexistent, A5). Targets are labelled by name only, never
 * by email. Read-only.
 *
 * P3.7: `kind: "enforced"` reads the refusals V2 made under `enforce`
 * instead — `authz.refused` with `reasonCode = ACCESS_POLICY_REFUSED` (the
 * same `{ dimension, reason, target, site }` details) — under the same rules.
 */
async function loadWouldRefuseRows(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    window: { from: Date; to: Date };
    viewer: ViewerProjectScope;
    connections: AgentAccessConnectionInput[];
    kind?: "would_refuse" | "enforced";
  },
): Promise<AgentAccessWouldRefuseRow[]> {
  const kindCondition =
    input.kind === "enforced"
      ? and(eq(activityLog.action, "authz.refused"), sql`${activityLog.details} ->> 'reasonCode' = ${ACCESS_POLICY_REFUSED}`)
      : eq(activityLog.action, "access.would_refuse");
  const targetProjectId = sql`(case when (${activityLog.details} -> 'target' ->> 'projectId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (${activityLog.details} -> 'target' ->> 'projectId')::uuid end)`;
  const rows = await db
    .select({ createdAt: activityLog.createdAt, details: activityLog.details })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.agentId, input.agentId),
        kindCondition,
        gte(activityLog.createdAt, input.window.from),
        lte(activityLog.createdAt, input.window.to),
        input.viewer.projectScoped(targetProjectId),
      ),
    )
    .orderBy(sql`${activityLog.createdAt} desc`)
    .limit(AGENT_ACCESS_WOULD_REFUSE_ROW_CAP);

  const detailsOf = (value: unknown) => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});
  const targetOf = (details: Record<string, unknown>) => detailsOf(details.target);
  const ids = (key: string) =>
    [...new Set(rows.map((row) => targetOf(detailsOf(row.details))[key]).filter((id): id is string => typeof id === "string"))];
  const projectIds = ids("projectId");
  const agentIds = ids("agentId");
  const userIds = ids("userId");
  const projectNames = new Map<string, string>();
  if (projectIds.length > 0) {
    for (const row of await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(and(eq(projects.companyId, input.companyId), inArray(projects.id, projectIds)))) {
      projectNames.set(row.id, row.name);
    }
  }
  const agentNames = new Map<string, string>();
  if (agentIds.length > 0) {
    for (const row of await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.companyId, input.companyId), inArray(agents.id, agentIds)))) {
      agentNames.set(row.id, row.name);
    }
  }
  const userNames = new Map<string, string | null>();
  if (userIds.length > 0) {
    for (const row of await db.select({ id: authUsers.id, name: authUsers.name }).from(authUsers).where(inArray(authUsers.id, userIds))) {
      userNames.set(row.id, row.name?.trim() || null);
    }
  }
  const connectionLabels = new Map(input.connections.map((connection) => [connection.id, connectionLabel(connection)]));

  return rows.map((row) => {
    const details = detailsOf(row.details);
    const target = targetOf(details);
    const dimension = typeof details.dimension === "string" ? details.dimension : "unknown";
    const reason = typeof details.reason === "string" ? details.reason : null;
    const str = (key: string) => (typeof target[key] === "string" ? (target[key] as string) : null);
    let targetLabel: string | null = null;
    if (str("projectId")) targetLabel = projectNames.get(str("projectId")!) ?? null;
    else if (target.projectId === null) targetLabel = "Work outside any project";
    else if (str("connectionId")) {
      const label = connectionLabels.get(str("connectionId")!) ?? null;
      const extra = str("externalTarget") ?? str("dataScope");
      targetLabel = extra ? `${label ?? "A connection"}: ${extra}` : label;
    } else if (str("skillKey")) targetLabel = str("skillKey");
    else if (str("agentId")) targetLabel = agentNames.get(str("agentId")!) ?? null;
    else if (str("userId")) targetLabel = userNames.get(str("userId")!) ?? "A company member";
    return {
      at: row.createdAt,
      dimension,
      // Logged as `<dimension>:<reason>` (the dotted form reads as a JWT to the
      // activity redaction); reported in its canonical dotted form.
      rule: reason ? `${dimension}.${reason}` : typeof details.rule === "string" ? details.rule : null,
      site: typeof details.site === "string" ? details.site : null,
      targetLabel,
    };
  });
}

/**
 * The connections this agent's resolution rule reaches (connectors.ts
 * `resolveActingAs`), including expired and errored rows so a broken one is
 * shown as not working rather than silently missing. Revoked rows are gone,
 * not broken, and are left out. For each active row the real resolver is
 * asked, naming that row, so ceilings and autonomy are decided by the code
 * that enforces them.
 */
async function loadConnections(
  db: Db,
  connectorsSvc: ReturnType<typeof connectorService>,
  input: { companyId: string; agentId: string; onProfile: boolean; stewardUserId: string | null },
): Promise<AgentAccessConnectionInput[]> {
  const rows = await db
    .select()
    .from(connections)
    .where(and(eq(connections.companyId, input.companyId), isNull(connections.revokedAt), ne(connections.status, "revoked")));

  const isActive = (row: typeof rows[number]) => row.status === "active";
  const candidates: Array<{ row: typeof rows[number]; via: AgentAccessConnectionInput["via"] }> = [];
  const providers = [...new Set(rows.map((row) => row.provider))];
  for (const provider of providers) {
    const forProvider = rows.filter((row) => row.provider === provider);
    if (isDocumentProvider(provider)) {
      // Only the current steward's own private row, on any profile.
      for (const row of forProvider) {
        if (input.stewardUserId && row.ownerType === "user" && row.ownerId === input.stewardUserId && row.visibility === "private") {
          candidates.push({ row, via: "steward_document" });
        }
      }
      continue;
    }
    const direct = forProvider.filter(
      (row) => (row.ownerType === "agent" && row.ownerId === input.agentId) || row.visibility === "workspace",
    );
    for (const row of direct) {
      candidates.push({ row, via: row.ownerType === "agent" && row.ownerId === input.agentId ? "own" : "workspace" });
    }
    // agentdash_mk only: the steward's own rows, consulted when no active
    // agent-owned or workspace row exists for the provider.
    if (input.onProfile && input.stewardUserId && !direct.some(isActive)) {
      for (const row of forProvider) {
        if (row.ownerType === "user" && row.ownerId === input.stewardUserId && !direct.includes(row)) {
          candidates.push({ row, via: "steward_fallback" });
        }
      }
    }
  }

  const result: AgentAccessConnectionInput[] = [];
  for (const { row, via } of candidates) {
    let resolutions: ConnectionResolutions | null = null;
    if (isActive(row)) {
      const resolve = (actionClass: ConnectorActionClass) =>
        connectorsSvc.resolveActingAs(input.companyId, input.agentId, actionClass, row.provider, { connectionId: row.id, accessCheck: false });
      resolutions = { read: await resolve("read"), draft: await resolve("draft"), send: await resolve("send") };
    }
    result.push({
      id: row.id,
      provider: row.provider,
      ownerType: row.ownerType,
      ownerId: row.ownerId,
      visibility: row.visibility,
      status: row.status,
      accountLabel: row.accountLabel,
      hasToken: row.encryptedToken != null,
      autonomy: (row.autonomy ?? {}) as Partial<Record<ConnectorActionClass, string>>,
      via,
      resolutions,
    });
  }
  return result;
}

/** The same window and sum the budget service enforces (budgets.ts computeObservedAmount). */
async function observedAgentSpend(db: Db, companyId: string, agentId: string, windowKind: string, now: Date) {
  const conditions = [eq(costEvents.companyId, companyId), eq(costEvents.agentId, agentId)];
  if (windowKind !== "lifetime") {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    conditions.push(gte(costEvents.occurredAt, start), lt(costEvents.occurredAt, end));
  }
  return db
    .select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision` })
    .from(costEvents)
    .where(and(...conditions))
    .then((rows) => Number(rows[0]?.total ?? 0));
}

/** Activity rows where the actor is this agent, in the window, aggregated per mapping key. */
async function loadMappedActivity(
  db: Db,
  companyId: string,
  agentId: string,
  window: { from: Date; to: Date },
): Promise<AgentAccessActivityRow[]> {
  const interactionKind = sql<string | null>`${activityLog.details}->>'interactionKind'`;
  const reasonCode = sql<string | null>`${activityLog.details}->>'reasonCode'`;
  const capabilitiesChanged = sql<boolean>`coalesce((${activityLog.details}->'changedTopLevelKeys') @> '["capabilities"]'::jsonb, false)`;
  const rows = await db
    .select({
      action: activityLog.action,
      entityId: activityLog.entityId,
      interactionKind,
      reasonCode,
      capabilitiesChanged,
      count: sql<number>`count(*)::int`,
      lastAt: sql<Date | null>`max(${activityLog.createdAt})`.mapWith(activityLog.createdAt),
    })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.actorType, "agent"),
        eq(activityLog.actorId, agentId),
        gte(activityLog.createdAt, window.from),
        lte(activityLog.createdAt, window.to),
        inArray(activityLog.action, [...AGENT_ACCESS_MAPPED_ACTIONS]),
      ),
    )
    .groupBy(activityLog.action, activityLog.entityId, interactionKind, reasonCode, capabilitiesChanged);
  return rows.map((row) => ({
    action: row.action,
    entityId: row.entityId,
    interactionKind: row.interactionKind ?? null,
    reasonCode: row.reasonCode ?? null,
    capabilitiesChanged: Boolean(row.capabilitiesChanged),
    count: Number(row.count ?? 0),
    lastAt: row.lastAt ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Pure builder
// ---------------------------------------------------------------------------

type Used = AgentAccessItem["used"];

const UNKNOWN_USE: Used = { state: "unknown", uses: null, refusals: null, lastAt: null };

function tally(rows: AgentAccessActivityRow[]): { count: number; lastAt: Date | null } {
  let count = 0;
  let lastAt: Date | null = null;
  for (const row of rows) {
    count += row.count;
    if (row.lastAt && (!lastAt || row.lastAt > lastAt)) lastAt = row.lastAt;
  }
  return { count, lastAt };
}

function observedUse(uses: AgentAccessActivityRow[], refusals: AgentAccessActivityRow[] = []): Used {
  const u = tally(uses);
  const r = tally(refusals);
  const lastAt = [u.lastAt, r.lastAt].filter((d): d is Date => d != null).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const state = u.count > 0 && r.count > 0 ? "used_and_refused" : u.count > 0 ? "used" : r.count > 0 ? "refused" : "not_observed";
  return { state, uses: u.count, refusals: r.count, lastAt: lastAt?.toISOString() ?? null };
}

/** Refusals only: uses of this item are not recorded anywhere we read. */
function refusalOnlyUse(refusals: AgentAccessActivityRow[]): Used {
  const r = tally(refusals);
  if (r.count === 0) return UNKNOWN_USE;
  return { state: "refused", uses: null, refusals: r.count, lastAt: r.lastAt?.toISOString() ?? null };
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function connectionLabel(connection: Pick<AgentAccessConnectionInput, "provider" | "accountLabel">): string {
  return connection.accountLabel ? `${connection.provider} (${connection.accountLabel})` : connection.provider;
}

const VIA_DETAIL: Record<AgentAccessConnectionInput["via"], string> = {
  own: "Its own connection",
  workspace: "Shared with the workspace",
  steward_document: "Its current steward's private document connection",
  steward_fallback: "Its steward's connection, used only when no agent-owned or workspace connection exists (agentdash_mk)",
};

/**
 * Which agent routes perform a draft or send for a provider. Verified in the
 * routes, not inferred from the autonomy settings: Gmail draft and send refuse
 * agents (`assertCanSetCompanyDirection`), Slack send is board-only, and the
 * HubSpot write route always files a `connector_send` approval.
 */
function agentRouteFor(provider: string, actionClass: "draft" | "send"): { available: boolean; detail: string } {
  if (provider === "hubspot") {
    return actionClass === "send"
      ? { available: true, detail: "POST /api/companies/:companyId/hubspot/:objectType/write always files a connector_send approval; nothing is written until a person approves" }
      : { available: false, detail: "No agent route drafts through HubSpot" };
  }
  if (provider === "gmail") return { available: false, detail: `Gmail ${actionClass} refuses agent callers; agents can only read` };
  if (provider === "slack") return { available: false, detail: `Slack ${actionClass} is board-only` };
  return { available: false, detail: `No agent route performs ${actionClass} through ${provider}` };
}

function governanceSummary(policy: AgentGovernancePolicy): string {
  const list = (values: string[]) => (values.includes(AGENT_POLICY_WILDCARD) ? "any" : values.length === 0 ? "none" : values.join(", "));
  const budget = policy.monthlyBudgetCents >= AGENT_POLICY_UNLIMITED_BUDGET_CENTS
    ? "no limit"
    : `${policy.monthlyBudgetCents} (${dollars(policy.monthlyBudgetCents)})`;
  return [
    `permissions: ${list(policy.permissions)}`,
    `monthlyBudgetCents: ${budget}`,
    `destructiveActions: ${policy.destructiveActions}`,
    `dataScopes: ${list(policy.dataScopes)}`,
    `providers: ${list(policy.providers)}`,
    `minimumApproval: ${policy.minimumApproval}`,
  ].join("; ");
}

export function buildAgentHostEnvironment(input: Pick<AgentAccessInventoryInput, "agent" | "environment">): AgentHostEnvironment {
  const { agent, environment } = input;
  const config = agent.adapterConfig ?? {};
  const extraArgs = Array.isArray(config.extraArgs) ? config.extraArgs.filter((a): a is string => typeof a === "string") : [];
  const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

  // Host permission prompts, per adapter, as each adapter's execute.ts builds its command.
  let restricted: boolean | "unknown" = "unknown";
  let how: string | null = null;
  switch (agent.adapterType) {
    case "claude_local": {
      const skip = flag(config.dangerouslySkipPermissions, true)
        || extraArgs.includes("--dangerously-skip-permissions");
      restricted = !skip;
      how = skip ? "permission prompts skipped (dangerouslySkipPermissions)" : "permission prompts apply";
      break;
    }
    case "acpx_local": {
      const mode = typeof config.permissionMode === "string" ? config.permissionMode.trim() : "approve-all";
      const approveAll = !(mode === "approve-reads" || mode === "deny-all" || mode === "default");
      restricted = !approveAll;
      how = approveAll ? "permissionMode approve-all" : `permissionMode ${mode}`;
      break;
    }
    case "codex_local": {
      const bypass = flag(config.dangerouslyBypassApprovalsAndSandbox, flag(config.dangerouslyBypassSandbox, false));
      if (bypass) {
        restricted = false;
        how = "approvals and sandbox bypassed";
      }
      break;
    }
    case "gemini_local": {
      if (!flag(config.sandbox, false)) {
        restricted = false;
        how = "approval mode yolo, no sandbox";
      }
      break;
    }
    case "cursor": {
      restricted = false;
      how = "runs with --yolo or a trust flag";
      break;
    }
    case "process": {
      restricted = false;
      how = "runs its configured command with the server's own host permissions";
      break;
    }
    default:
      break;
  }

  const permissionText =
    restricted === false ? "host permissions not restricted" : restricted === true ? "host permissions restricted" : "host permissions unknown";

  if (agent.defaultEnvironmentId) {
    if (!environment) {
      return {
        adapterType: agent.adapterType,
        kind: "unknown",
        hostPermissionsRestricted: restricted,
        environmentId: agent.defaultEnvironmentId,
        detail: "Its default environment could not be found in this company",
      };
    }
    if (environment.driver !== "local") {
      return {
        adapterType: agent.adapterType,
        kind: "managed_environment",
        hostPermissionsRestricted: restricted,
        environmentId: environment.id,
        detail: `Managed environment "${environment.name}" (${environment.driver})${how ? `, ${how}` : ""}`,
      };
    }
    // A default environment on the `local` driver is this machine.
    return {
      adapterType: agent.adapterType,
      kind: "local_host",
      hostPermissionsRestricted: restricted,
      environmentId: environment.id,
      detail: `Local machine (environment "${environment.name}"), ${permissionText}${how ? `: ${how}` : ""}`,
    };
  }

  if (agent.adapterType.endsWith("_local") || agent.adapterType === "process") {
    return {
      adapterType: agent.adapterType,
      kind: "local_host",
      hostPermissionsRestricted: restricted,
      environmentId: null,
      detail: `Local machine, ${permissionText}${how ? `: ${how}` : ""}`,
    };
  }
  if (agent.adapterType === "http" || agent.adapterType === "openclaw_gateway") {
    return {
      adapterType: agent.adapterType,
      kind: "remote",
      hostPermissionsRestricted: "unknown",
      environmentId: null,
      detail: "Runs outside this server at its configured endpoint; host permissions there are unknown",
    };
  }
  return {
    adapterType: agent.adapterType,
    kind: "unknown",
    hostPermissionsRestricted: restricted,
    environmentId: null,
    detail: `Execution environment for adapter ${agent.adapterType} is unknown`,
  };
}

export function buildAgentAccessInventory(input: AgentAccessInventoryInput): AgentAccessInventory {
  const { agent, company } = input;
  const items: AgentAccessItem[] = [];
  const gaps: AgentAccessGap[] = input.profile
    ? []
    : [
        {
          code: "PROFILE_NOT_DEFINED",
          message: "No person has defined this agent's access yet. Everything here is what today's rules allow.",
          itemId: null,
        },
      ];
  // Placeholder; `applyProfileAndAccessV2` sets each item's Requested from the active revision.
  const requested = { state: "not_defined" } as const;
  const onProfile = input.governance.onProfile;
  const isCeo = agent.role === "ceo";
  const permissions = normalizeAgentPermissions(agent.permissions, agent.role);
  const membershipActive = input.membershipStatus === "active";
  const grantKeys = new Set(input.grants.map((grant) => grant.permissionKey));

  const activity = (predicate: (row: AgentAccessActivityRow) => boolean) => input.activity.filter(predicate);

  // ---- See ----------------------------------------------------------------

  items.push({
    id: "see.company",
    dimension: "see",
    label: "Read only inside its own company",
    target: { kind: "company", id: company.id },
    requested,
    defined: { allowed: true, source: "company_boundary" },
    enforced: { state: "enforced", note: "Agent keys and run tokens are refused on every other company" },
    working: { state: "ok" },
    used: refusalOnlyUse(activity((row) => row.action === "authz.refused" && row.reasonCode === "AGENT_CROSS_COMPANY")),
  });

  const openProjects = input.projects.filter((project) => project.visibility === "company");
  const archivedOpen = openProjects.filter((project) => project.archived).length;
  items.push({
    id: "see.projects.open",
    dimension: "see",
    label: "Read issues in every project that isn't restricted",
    target: { kind: "project", count: openProjects.length },
    requested,
    defined: {
      allowed: "unrestricted",
      source: "project_visibility",
      detail:
        plural(openProjects.length, "project") +
        (archivedOpen > 0 ? ` (${archivedOpen} archived)` : "") +
        // AgentDash (APM gate 1): said whenever the rule can hide something, never with a count.
        (input.projectsWithheld ? `. ${RESTRICTED_PROJECTS_WITHHELD_NOTE}` : ""),
    },
    enforced: { state: "partial", note: RUN_CONTEXT_NOTE },
    working: { state: "ok" },
    used: UNKNOWN_USE,
  });
  gaps.push({
    code: "RUN_CONTEXT_UNCHECKED",
    message:
      "Project visibility is checked on API reads only. A run's issue, wake comment and continuation documents are loaded without it, and company export does not apply it.",
    itemId: "see.projects.open",
  });

  for (const project of input.projects.filter((p) => p.visibility !== "company")) {
    const lead = project.leadAgentId === agent.id;
    const detail = project.onAccessList
      ? "On the project's access list"
      : lead
        ? "Lead of this project but not on its access list; read checks use the access list only"
        : "Not on the project's access list";
    items.push({
      id: `see.project:${project.id}`,
      dimension: "see",
      label: `Read restricted project "${project.name}"`,
      target: { kind: "project", id: project.id, label: project.name },
      requested,
      defined: { allowed: project.onAccessList, source: "project_access", detail },
      enforced: { state: "partial", note: RUN_CONTEXT_NOTE },
      working: project.archived ? { state: "ok", detail: "Archived" } : { state: "ok" },
      used: UNKNOWN_USE,
    });
  }

  for (const connection of input.connections) {
    const working = connectionWorking(connection);
    const read = connection.resolutions?.read;
    const allowed = read ? read.ok : true;
    const autonomyDetail = read && read.ok ? `read autonomy ${read.resolution.effectiveAutonomy}` : read && !read.ok ? read.blocked.message : null;
    items.push({
      id: `see.connection:${connection.id}`,
      dimension: "see",
      label: `Read through ${connectionLabel(connection)}`,
      target: { kind: "connection", id: connection.id, label: connectionLabel(connection) },
      requested,
      defined: {
        allowed,
        source: "connector_resolution",
        detail: [VIA_DETAIL[connection.via], autonomyDetail].filter(Boolean).join("; "),
      },
      enforced: {
        state: "profile_only",
        note: onProfile
          ? "Connection ownership is checked on every connector route; the owner ceiling's providers and dataScopes also apply here (agentdash_mk)"
          : "Connection ownership is checked on every connector route; the provider and data-scope ceilings run only on the agentdash_mk profile, which this company is not on",
      },
      working,
      used: UNKNOWN_USE,
    });
    if (working.state === "not_working") {
      gaps.push({
        code: "CONNECTION_NOT_WORKING",
        message: `The ${connectionLabel(connection)} connection is ${working.detail ?? "not working"}.`,
        itemId: `see.connection:${connection.id}`,
      });
    }
  }

  items.push({
    id: "see.agent_memory",
    dimension: "see",
    label: "Its memory is private to it, its steward and company admins",
    target: { kind: "agent", id: agent.id, label: agent.name },
    requested,
    defined: { allowed: true, source: "agent_memory_privacy" },
    enforced: {
      state: "enforced",
      note: "GET /api/companies/:companyId/agents/:agentId/memory admits the agent, its active steward and company admins; anyone else gets 404",
    },
    working: { state: "not_applicable" },
    used: UNKNOWN_USE,
  });

  if (isCeo) {
    items.push({
      id: "see.company.export",
      dimension: "see",
      label: "Export the whole company, including restricted projects",
      target: { kind: "company", id: company.id },
      requested,
      defined: { allowed: true, source: "role_default", detail: "CEO agents may export (POST /api/companies/:companyId/export)" },
      enforced: { state: "not_enforced", note: "The export lists every issue without applying project visibility" },
      working: { state: "ok" },
      used: UNKNOWN_USE,
    });
    gaps.push({
      code: "EXPORT_UNSCOPED",
      message: "As a CEO agent it can export the company, and the export reads every issue without project visibility.",
      itemId: "see.company.export",
    });
  }

  // ---- Do -----------------------------------------------------------------

  const permissionKeys = new Set<string>(grantKeys);
  if (permissions.canCreateAgents) permissionKeys.add("agents:create");
  if (isCeo || permissions.canCreateAgents) permissionKeys.add("tasks:assign");
  for (const key of [...permissionKeys].sort()) {
    const grant = input.grants.find((g) => g.permissionKey === key) ?? null;
    const itemId = `do.permission:${key}`;
    const notes: string[] = [];
    let allowed: boolean;
    let source: AgentAccessItem["defined"]["source"];
    let detail: string;
    // Grant rows count only with an active membership (access.ts hasPermission);
    // the legacy flag and the role fallback are read off the agent row.
    let needsMembership = false;
    if (grant && membershipActive) {
      allowed = true;
      source = "permission_grant";
      detail = "Granted";
      needsMembership = true;
    } else if (key === "agents:create" && permissions.canCreateAgents) {
      allowed = true;
      const explicit = typeof agent.permissions?.canCreateAgents === "boolean";
      source = explicit ? "permission_grant" : "role_default";
      detail = explicit ? "Legacy flag permissions.canCreateAgents is true" : "Default for the CEO role (canCreateAgents)";
    } else if (key === "tasks:assign" && (isCeo || permissions.canCreateAgents)) {
      allowed = true;
      source = "role_default";
      detail = isCeo ? "Allowed by the CEO role when the grant is missing" : "Allowed by canCreateAgents when the grant is missing";
    } else {
      allowed = false;
      source = "permission_grant";
      detail = "Granted, but the agent's company membership is not active, so the grant is not honoured";
      needsMembership = true;
    }
    if (grant?.scope && Object.keys(grant.scope).length > 0) notes.push("The grant's scope is stored but never read");

    let enforced: AgentAccessItem["enforced"];
    if (key === "tasks:assign_scope") {
      enforced = { state: "not_enforced", note: "No check reads this key" };
      gaps.push({ code: "UNREAD_PERMISSION_SCOPE", message: "tasks:assign_scope is granted, but no check reads it or any grant's scope.", itemId });
    } else if (!AGENT_CHECKED_PERMISSION_KEYS.has(key)) {
      allowed = false;
      detail = `${detail}; no route checks ${key} for an agent caller`;
      enforced = { state: "not_enforced", note: "Not read for agent principals" };
    } else {
      enforced = { state: "enforced", note: notes.length > 0 ? notes.join("; ") : null };
    }
    items.push({
      id: itemId,
      dimension: "do",
      label: `${PERMISSION_LABELS[key] ?? "Permission"} (${key})`,
      requested,
      defined: { allowed, source, detail },
      enforced,
      working: !needsMembership || membershipActive ? { state: "ok" } : { state: "not_working", detail: "Agent membership is not active" },
      used: UNKNOWN_USE,
    });
  }

  for (const connection of input.connections) {
    const working = connectionWorking(connection);
    for (const actionClass of ["draft", "send"] as const) {
      const chain = autonomyChain(input, connection, actionClass);
      const route = agentRouteFor(connection.provider, actionClass);
      const resolution = connection.resolutions?.[actionClass];
      const resolvedAllowed = resolution ? resolution.ok : chain.effective !== "blocked";
      const blockedDetail = resolution && !resolution.ok ? resolution.blocked.message : null;
      items.push({
        id: `do.connection:${connection.id}.${actionClass}`,
        dimension: "do",
        label: `${actionClass === "draft" ? "Draft" : "Send"} through ${connectionLabel(connection)}`,
        target: { kind: "connection", id: connection.id, label: connectionLabel(connection) },
        requested,
        defined: {
          allowed: route.available && resolvedAllowed,
          source: "connector_autonomy",
          detail: [chain.detail, blockedDetail, route.detail].filter(Boolean).join("; "),
        },
        enforced: { state: "enforced" },
        working: route.available ? working : { state: "not_applicable" },
        used: UNKNOWN_USE,
      });
    }
  }

  items.push({
    id: "do.skills.self_add",
    dimension: "do",
    label: "Add any company skill to itself",
    target: { kind: "skill", count: input.companySkillCount },
    requested,
    defined: { allowed: "unrestricted", source: "skill_sync", detail: "POST /api/agents/:id/skills/sync on itself" },
    enforced: { state: "not_enforced", note: "Self skill sync accepts any company skill" },
    working: { state: "not_applicable" },
    used: observedUse(activity((row) => row.action === "agent.skills_synced" && row.entityId === agent.id)),
  });
  gaps.push({ code: "SELF_ADD_SKILLS", message: "It can add any company skill to itself through skill sync.", itemId: "do.skills.self_add" });

  items.push({
    id: "do.skills.runtime_mentions",
    dimension: "do",
    label: "Get a skill added to a run by naming it in an issue",
    target: { kind: "skill", count: input.companySkillCount },
    requested,
    defined: { allowed: "unrestricted", source: "runtime_skill_mentions" },
    enforced: { state: "not_enforced", note: "Skills mentioned in the issue's title, description or comments join the run without skill sync" },
    working: { state: "not_applicable" },
    used: UNKNOWN_USE,
  });
  gaps.push({
    code: "RUNTIME_SKILL_MENTIONS",
    message: "A skill mentioned in an issue's text or comments is added to the run without going through skill sync.",
    itemId: "do.skills.runtime_mentions",
  });

  const canModifyPeers = isCeo || permissions.canCreateAgents || (membershipActive && grantKeys.has("agents:create"));
  items.push({
    id: "do.capabilities.self_edit",
    dimension: "do",
    label: canModifyPeers ? "Rewrite its own and other agents' capabilities text" : "Rewrite its own capabilities text",
    target: { kind: "agent", id: agent.id, label: agent.name },
    requested,
    defined: {
      allowed: true,
      source: "platform_default",
      detail: canModifyPeers
        ? "capabilities is on both the self-edit and the peer-edit lists of PATCH /api/agents/:id"
        : "capabilities is on the self-edit list of PATCH /api/agents/:id",
    },
    enforced: { state: "not_enforced", note: "Nothing limits what it writes there" },
    working: { state: "not_applicable" },
    used: observedUse(activity((row) => row.action === "agent.updated" && row.entityId === agent.id && row.capabilitiesChanged)),
  });
  gaps.push({ code: "SELF_EDIT_CAPABILITIES", message: "It can rewrite its own capabilities text.", itemId: "do.capabilities.self_edit" });

  if (onProfile && input.governance.effectivePolicy) {
    items.push({
      id: "do.governance",
      dimension: "do",
      label: "Governance policy (owner ceiling ∩ steward request)",
      requested,
      defined: { allowed: true, source: "governance_policy", detail: governanceSummary(input.governance.effectivePolicy) },
      enforced: { state: "profile_only", note: "agentdash_mk only; this company is on it" },
      working: { state: "ok" },
      used: UNKNOWN_USE,
    });
  } else {
    items.push({
      id: "do.governance",
      dimension: "do",
      label: "Governance policy (owner ceiling ∩ steward request)",
      requested,
      defined: { allowed: "unrestricted", source: "governance_policy", detail: "No ceiling applies to this company" },
      enforced: { state: "profile_only", note: "agentdash_mk only; this company is not on it" },
      working: { state: "not_applicable" },
      used: UNKNOWN_USE,
    });
    gaps.push({
      code: "GOVERNANCE_PROFILE_ONLY",
      message: "Governance ceilings run only on the agentdash_mk profile. This company is not on it, so no ceiling narrows this agent.",
      itemId: "do.governance",
    });
  }

  for (const mandate of input.mandates) {
    const grantor = mandate.grantorName ?? "another agent";
    items.push({
      id: `do.mandate:${mandate.id}`,
      dimension: "do",
      label: `Act under a mandate from ${grantor}`,
      target: { kind: "agent", id: mandate.grantorAgentId, label: mandate.grantorName },
      requested,
      defined: {
        allowed: true,
        source: "mandate",
        detail: `scope: ${mandate.scope.length > 0 ? mandate.scope.join(", ") : "none"}; permission: ${mandate.permissionKey}; cap: ${dollars(mandate.spendCapCents)}; expires: ${mandate.expiresAt.toISOString()}`,
      },
      enforced: { state: "partial", note: "Checked only when POST /api/mandated-actions is called" },
      working: { state: "ok" },
      used: UNKNOWN_USE,
    });
  }

  // ---- Talk ---------------------------------------------------------------

  const reachableAgents = input.peers.filter((peer) => peer.status !== "terminated").length;
  const canAssign = (membershipActive && grantKeys.has("tasks:assign")) || isCeo || permissions.canCreateAgents;
  const wakeGap = (itemId: string, how: string) =>
    gaps.push({ code: "WAKE_ANY_AGENT", message: `It can wake any agent in the company by ${how}; nothing limits who.`, itemId });

  items.push({
    id: "talk.agents.assign",
    dimension: "talk",
    label: "Assign work to other agents",
    target: { kind: "agent", count: reachableAgents },
    requested,
    defined: canAssign
      ? { allowed: "unrestricted", source: "issue_assignment", detail: "Needs tasks:assign, or the CEO role or canCreateAgents as a fallback" }
      : { allowed: false, source: "issue_assignment", detail: "No tasks:assign grant, CEO role or canCreateAgents" },
    enforced: canAssign
      ? {
          state: isCeo ? "partial" : "not_enforced",
          note: isCeo
            ? "tasks:assign is checked on issue create and update, never which agent; a company import by a CEO agent assigns issues without it"
            : "tasks:assign is checked, never which agent",
        }
      : { state: "enforced" },
    working: { state: "ok" },
    used: UNKNOWN_USE,
  });
  if (canAssign) wakeGap("talk.agents.assign", "assigning it work");

  items.push({
    id: "talk.agents.mention",
    dimension: "talk",
    label: "Wake other agents by mentioning them in a comment",
    target: { kind: "agent", count: reachableAgents },
    requested,
    defined: { allowed: "unrestricted", source: "mentions" },
    enforced: { state: "not_enforced", note: "No allowlist: a mention wakes the named agent while the issue is open, and a plain comment wakes the assignee" },
    working: { state: "ok" },
    used: UNKNOWN_USE,
  });
  wakeGap("talk.agents.mention", "mentioning it in a comment");

  const handoffUses = activity((row) => row.action === "issue.agent_handoff" || row.action === "issue.agent_handoff_returned");
  const handoffRefusals = activity((row) => row.action === "issue.agent_handoff_refused");
  items.push({
    id: "talk.agents.handoff",
    dimension: "talk",
    label: "Hand work to another agent",
    target: { kind: "agent", count: reachableAgents },
    requested,
    defined: canAssign
      ? { allowed: "unrestricted", source: "handoffs", detail: "A hand-off is an issue assigned to the other agent, so it needs the same authority as assigning" }
      : { allowed: false, source: "handoffs", detail: "No authority to assign work" },
    enforced: {
      state: "not_enforced",
      note: input.handoffsEnabled
        ? "No limit on who; at most 3 agent-to-agent rounds per request (coworker_bridge_enabled is on)"
        : "No limit on who; the round cap is off because coworker_bridge_enabled is off",
    },
    working: { state: "ok" },
    used: input.handoffsEnabled || handoffUses.length > 0 || handoffRefusals.length > 0 ? observedUse(handoffUses, handoffRefusals) : UNKNOWN_USE,
  });
  if (canAssign) wakeGap("talk.agents.handoff", "handing work to it");

  items.push({
    id: "talk.people.questions",
    dimension: "talk",
    label: "Ask people questions on issues",
    target: { kind: "person", count: input.activeMemberCount },
    requested,
    defined: {
      allowed: "unrestricted",
      source: "questions",
      detail: "On a workforce issue the question goes to the accountable member; elsewhere an agent cannot name an owner, so anyone who can see the issue may answer",
    },
    enforced: { state: "not_enforced", note: "Nothing limits which people it asks" },
    working: { state: "ok" },
    used: observedUse(activity((row) => row.action === "issue.thread_interaction_created" && row.interactionKind === "ask_user_questions")),
  });
  gaps.push({
    code: "ASK_ANY_MEMBER",
    message: "Nothing limits which people it can ask: outside workforce issues its questions go to anyone who can see the issue.",
    itemId: "talk.people.questions",
  });

  const hubspotUsable = input.connections.some(
    (connection) => connection.provider === "hubspot" && connection.resolutions?.send.ok === true,
  );
  items.push({
    id: "talk.external.hubspot",
    dimension: "talk",
    label: "Write to HubSpot",
    target: { kind: "external", label: "HubSpot" },
    requested,
    defined: onProfile
      ? { allowed: true, source: "platform_default", detail: "Every write files a connector_send approval; nothing is written until a person approves" }
      : { allowed: false, source: "platform_default", detail: "The HubSpot routes exist only on the agentdash_mk profile" },
    enforced: onProfile ? { state: "enforced" } : { state: "profile_only", note: "agentdash_mk only; this company is not on it" },
    working: onProfile
      ? hubspotUsable
        ? { state: "ok" }
        : { state: "not_working", detail: "No HubSpot connection this agent can use" }
      : { state: "not_applicable" },
    used: observedUse(activity((row) => row.action === "connection.hubspot_write_requested")),
  });
  items.push({
    id: "talk.external.gmail",
    dimension: "talk",
    label: "Send email through Gmail",
    target: { kind: "external", label: "Gmail" },
    requested,
    defined: { allowed: false, source: "platform_default", detail: "Gmail draft and send refuse agent callers" },
    enforced: { state: "enforced" },
    working: { state: "not_applicable" },
    used: UNKNOWN_USE,
  });
  items.push({
    id: "talk.external.slack",
    dimension: "talk",
    label: "Post to Slack",
    target: { kind: "external", label: "Slack" },
    requested,
    defined: { allowed: false, source: "platform_default", detail: "Slack send is board-only" },
    enforced: { state: "enforced" },
    working: { state: "not_applicable" },
    used: UNKNOWN_USE,
  });

  const effectiveVisibility = agent.visibility ?? company.agentVisibilityDefault;
  items.push({
    id: "talk.inbound.people",
    dimension: "talk",
    label: "People who can assign work to it",
    target: { kind: "person", count: effectiveVisibility === "owner" ? null : input.activeMemberCount },
    requested,
    defined: {
      allowed: "unrestricted",
      source: "issue_assignment",
      detail:
        effectiveVisibility === "owner"
          ? "Every member holds tasks:assign, but this agent is visible only to admins and the people who answer for it; others get 404"
          : "Every active member holds tasks:assign",
    },
    enforced: { state: "not_enforced", note: "No inbound scope" },
    working: { state: "ok" },
    used: UNKNOWN_USE,
  });
  const inboundAgents = input.peers.filter(
    (peer) => peer.status !== "terminated" && (peer.hasTaskAssignGrant || peer.role === "ceo" || peer.canCreateAgents),
  ).length;
  items.push({
    id: "talk.inbound.agents",
    dimension: "talk",
    label: "Agents who can assign work to it",
    target: { kind: "agent", count: inboundAgents },
    requested,
    defined: { allowed: "unrestricted", source: "issue_assignment", detail: "Agents holding tasks:assign, the CEO role or canCreateAgents" },
    enforced: { state: "not_enforced", note: "No inbound scope" },
    working: { state: "ok" },
    used: UNKNOWN_USE,
  });

  // ---- Spend --------------------------------------------------------------

  const policy = input.budget.policy;
  const spent = input.budget.observedCents;
  const pausedForBudget = agent.status === "paused" && agent.pauseReason === "budget";
  const windowText = policy?.windowKind === "lifetime" ? "in total" : "this month (UTC)";
  if (policy && policy.amount > 0) {
    const overLimit = spent >= policy.amount;
    items.push({
      id: "spend.budget",
      dimension: "spend",
      label: "Monthly budget",
      target: { kind: "budget", label: dollars(policy.amount) },
      requested,
      defined: {
        allowed: true,
        source: "budget_policy",
        detail: `Up to ${dollars(policy.amount)} ${policy.windowKind === "lifetime" ? "in total" : "per calendar month (UTC)"}; hard stop ${policy.hardStopEnabled ? "on" : "off"}`,
      },
      enforced: policy.hardStopEnabled
        ? { state: "enforced", note: "Checked when a run is claimed; the agent is paused at the limit" }
        : { state: "not_enforced", note: "Hard stop is off: crossing the budget only warns" },
      working: pausedForBudget
        ? { state: "not_working", detail: `Paused at the hard stop: spent ${dollars(spent)} of ${dollars(policy.amount)} ${windowText}` }
        : overLimit && policy.hardStopEnabled
          ? { state: "not_working", detail: `Spent ${dollars(spent)} of ${dollars(policy.amount)} ${windowText}` }
          : { state: "ok", detail: `Spent ${dollars(spent)} of ${dollars(policy.amount)} ${windowText}` },
      used: UNKNOWN_USE,
    });
  } else {
    items.push({
      id: "spend.budget",
      dimension: "spend",
      label: "Monthly budget",
      target: { kind: "budget" },
      requested,
      defined: {
        allowed: "unrestricted",
        source: "budget_policy",
        detail:
          agent.budgetMonthlyCents > 0
            ? `No active budget policy; the agent's budget field says ${dollars(agent.budgetMonthlyCents)} but nothing enforces it`
            : "No agent budget is set",
      },
      enforced: { state: "not_enforced", note: "No budget policy for this agent; a company or project budget may still stop it" },
      working: pausedForBudget
        ? { state: "not_working", detail: "Paused at a budget hard stop" }
        : { state: "ok", detail: `Spent ${dollars(spent)} this month (UTC)` },
      used: UNKNOWN_USE,
    });
  }

  if (onProfile && input.governance.effectivePolicy) {
    const ceiling = input.governance.effectivePolicy.monthlyBudgetCents;
    const unlimited = ceiling >= AGENT_POLICY_UNLIMITED_BUDGET_CENTS;
    items.push({
      id: "spend.governance_budget",
      dimension: "spend",
      label: "Governance budget ceiling",
      target: { kind: "budget", label: unlimited ? null : dollars(ceiling) },
      requested,
      defined: unlimited
        ? { allowed: "unrestricted", source: "governance_policy", detail: "The governance policy sets no budget limit" }
        : { allowed: true, source: "governance_policy", detail: `The agent's monthly budget may not exceed ${dollars(ceiling)}` },
      enforced: {
        state: "profile_only",
        note: "agentdash_mk only: budget changes above it are refused, and lowering it lowers the agent's budget",
      },
      working: { state: "ok" },
      used: UNKNOWN_USE,
    });
  }

  // ---- Host, reachability -------------------------------------------------

  const hostEnvironment = buildAgentHostEnvironment(input);
  if (hostEnvironment.hostPermissionsRestricted === false) {
    gaps.push({
      code: "HOST_UNRESTRICTED",
      message: "Its process runs with host permission prompts skipped, so it can change files on that machine, including its own instructions.",
      itemId: null,
    });
  }

  const alwaysReachable: AgentAccessInventory["alwaysReachable"] = [];
  const seen = new Set<string>();
  const reach = (userId: string | null | undefined, name: string | null, role: "accountable" | "steward" | "admin") => {
    if (!userId || seen.has(userId)) return;
    seen.add(userId);
    alwaysReachable.push({ kind: "user", id: userId, label: name ?? "A company member", role });
  };
  reach(input.steward?.userId, input.steward?.name ?? null, "steward");
  reach(input.accountability?.userId, input.accountability?.name ?? null, "accountable");
  for (const admin of input.admins) reach(admin.userId, admin.name, "admin");

  return {
    kind: "agent_access_inventory",
    version: "agent-access/0",
    companyId: company.id,
    agentId: agent.id,
    agentName: agent.name,
    generatedAt: input.generatedAt.toISOString(),
    window: { from: input.window.from.toISOString(), to: input.window.to.toISOString() },
    profileDefined: Boolean(input.profile),
    enforcementMode: input.enforcementMode ?? "off",
    items: applyProfileAndAccessV2(items, input),
    hostEnvironment,
    refusalsByCode: tallyRefusals(input.refusalCounts).byCode,
    alwaysReachable,
    gaps,
    shadow: buildShadowSummary(input),
    enforced: buildEnforcedSummary(input),
  };
}

/** AgentDash (APM gate 3, P3.7): refusals V2 made in the window; null when the mode is off (as `shadow`). Pure. */
function buildEnforcedSummary(input: AgentAccessInventoryInput): AgentAccessEnforcedSummary | null {
  if ((input.enforcementMode ?? "off") === "off") return null;
  const rows = input.enforcedRefusals ?? [];
  return {
    refusedTotal: rows.length,
    recent: rows.slice(0, SHADOW_RECENT_LIMIT).map((row) => ({
      at: row.at.toISOString(),
      dimension: row.dimension,
      rule: row.rule,
      site: row.site,
      targetLabel: row.targetLabel,
    })),
  };
}

/** AgentDash (APM gate 2): would-be refusals in the window; null when the mode is off. Pure. */
function buildShadowSummary(input: AgentAccessInventoryInput): AgentAccessShadowSummary | null {
  if ((input.enforcementMode ?? "off") === "off") return null;
  const rows = input.wouldRefuse ?? [];
  const byDimension: Record<string, number> = {};
  for (const row of rows) byDimension[row.dimension] = (byDimension[row.dimension] ?? 0) + 1;
  return {
    wouldRefuseTotal: rows.length,
    byDimension,
    recent: rows.slice(0, SHADOW_RECENT_LIMIT).map((row) => ({
      at: row.at.toISOString(),
      dimension: row.dimension,
      rule: row.rule,
      site: row.site,
      targetLabel: row.targetLabel,
    })),
  };
}

function connectionWorking(connection: AgentAccessConnectionInput): AgentAccessItem["working"] {
  if (connection.status !== "active") return { state: "not_working", detail: connection.status };
  if (isDocumentProvider(connection.provider) && !connection.hasToken) {
    return { state: "not_working", detail: "missing its credential" };
  }
  return { state: "ok" };
}

/** Workspace default → connection → agent override, the order `resolveActingAs` applies. */
function autonomyChain(
  input: Pick<AgentAccessInventoryInput, "connectorDefaults" | "agentConnectorOverride">,
  connection: AgentAccessConnectionInput,
  actionClass: ConnectorActionClass,
): { effective: string; detail: string } {
  const workspace = input.connectorDefaults[actionClass];
  const onConnection = connection.autonomy[actionClass] || null;
  const override = input.agentConnectorOverride?.[actionClass] || null;
  const effective = override ?? onConnection ?? workspace;
  return {
    effective,
    detail: `${actionClass} autonomy ${effective} (workspace ${workspace} → connection ${onConnection ?? "not set"} → agent override ${override ?? "not set"})`,
  };
}

// ---------------------------------------------------------------------------
// AgentDash (APM gate 2, P2.3): Requested from the active profile, Defined V2
// ---------------------------------------------------------------------------

type ProfileAccess = AgentAccessPolicy;
type RequestedState = AgentAccessItem["requested"];
type V2Defined = NonNullable<AgentAccessItem["defined"]["v2"]>;

function connectionIdOf(itemId: string, prefix: string): string | null {
  if (!itemId.startsWith(prefix)) return null;
  const rest = itemId.slice(prefix.length);
  const dot = rest.indexOf(".");
  return dot === -1 ? rest : rest.slice(0, dot);
}

function contactAdmitsSome(scope: AgentAccessContactScope | undefined, kind: "agent" | "person"): boolean {
  if (!scope) return true;
  if (scope.mode === "any" || scope.mode === "reports_chain") return true;
  if (scope.mode === "accountable_only") return kind === "person";
  return (kind === "agent" ? scope.agentIds ?? [] : scope.userIds ?? []).length > 0;
}

/**
 * Does the active revision's `access` ask for this item? `true`/`false` map to
 * requested/not_requested; `null` = the profile has no field for it. An
 * omitted V2 dimension asks for today's access (access LLD §7).
 */
function profileRequests(item: AgentAccessItem, access: ProfileAccess, input: AgentAccessInventoryInput): boolean | null {
  const id = item.id;
  const projectsScope = access.see?.projects;
  if (id === "see.company" || id === "do.governance" || id === "spend.budget" || id === "spend.governance_budget") return true;
  if (id === "see.projects.open" || id === "see.company.export") return !projectsScope || projectsScope.mode === "all";
  if (id.startsWith("see.project:")) {
    const projectId = id.slice("see.project:".length);
    return !projectsScope || projectsScope.mode === "all" || projectsScope.ids.includes(projectId);
  }
  const seeConnection = connectionIdOf(id, "see.connection:");
  if (seeConnection) return !access.see?.connections || access.see.connections.some((entry) => entry.connectionId === seeConnection);
  const doConnection = connectionIdOf(id, "do.connection:");
  if (doConnection) {
    const actionClass = id.endsWith(".send") ? "send" : "draft";
    if (!access.do?.connections) return true;
    const entry = access.do.connections.find((candidate) => candidate.connectionId === doConnection);
    return Boolean(entry && entry[actionClass] !== "never");
  }
  if (id.startsWith("do.permission:")) return policyListAllows(access.permissions, id.slice("do.permission:".length));
  if (id === "do.skills.self_add" || id === "do.skills.runtime_mentions") return !access.do?.skills || access.do.skills.mode === "all";
  // capabilities is profile-managed: a profile never asks for self-edits (access LLD §3.1).
  if (id === "do.capabilities.self_edit") return false;
  const agents = access.talk?.agents;
  const viaFor: Record<string, "assign" | "mention" | "handoff"> = {
    "talk.agents.assign": "assign",
    "talk.agents.mention": "mention",
    "talk.agents.handoff": "handoff",
  };
  if (viaFor[id]) return !agents || (agents.via.includes(viaFor[id]!) && contactAdmitsSome(agents, "agent"));
  if (id === "talk.people.questions") return true; // the escalation contacts are always reachable
  if (id === "talk.external.hubspot") {
    if (!access.talk?.external) return true;
    const hubspotIds = new Set(input.connections.filter((connection) => connection.provider === "hubspot").map((connection) => connection.id));
    return access.talk.external.some((entry) => hubspotIds.has(entry.connectionId));
  }
  if (id === "talk.inbound.people") return !access.talk?.inbound || access.talk.inbound.mode === "any";
  if (id === "talk.inbound.agents") return !access.talk?.inbound || access.talk.inbound.mode === "any";
  return null;
}

function sideDefines(policy: AgentAccessPolicy | null, section: "see" | "do" | "talk", field: string): boolean {
  return Boolean(policy && (policy[section] as Record<string, unknown> | undefined)?.[field] !== undefined);
}

/**
 * What the stored V2 sides allow for this item, when a V2 dimension covers
 * it. Targeted items are evaluated with `evaluateAccessV2` (the same function
 * the server checks call); aggregate items say whether V2 narrows them.
 * Undefined = V2 says nothing about the item.
 */
function definedV2(item: AgentAccessItem, input: AgentAccessInventoryInput): V2Defined | undefined {
  const policy = input.accessPolicy;
  if (!policy) return undefined;
  const { ceiling, request, context } = policy;
  const defines = (section: "see" | "do" | "talk", field: string) => sideDefines(ceiling, section, field) || sideDefines(request, section, field);
  const evaluate = (check: AgentAccessV2Check): V2Defined => {
    const decision = evaluateAccessV2(ceiling, request, check, context);
    return decision.decision === "allow" ? { allowed: true, rule: null } : { allowed: false, rule: decision.rule };
  };
  const id = item.id;

  if (id === "see.projects.open" || id === "see.company.export") {
    if (!defines("see", "projects")) return undefined;
    const projects = id === "see.projects.open" ? input.projects.filter((project) => project.visibility === "company") : input.projects;
    for (const project of projects) {
      const result = evaluate({ dimension: "see.projects", target: { projectId: project.id } });
      if (!result.allowed) return result;
    }
    return projects.length > 0 ? { allowed: true, rule: null } : { allowed: true, rule: "see.projects.listed" };
  }
  if (id.startsWith("see.project:")) {
    if (!defines("see", "projects")) return undefined;
    return evaluate({ dimension: "see.projects", target: { projectId: id.slice("see.project:".length) } });
  }
  const seeConnection = connectionIdOf(id, "see.connection:");
  if (seeConnection) {
    if (!defines("see", "connections")) return undefined;
    return evaluate({ dimension: "see.connections", target: { connectionId: seeConnection } });
  }
  const doConnection = connectionIdOf(id, "do.connection:");
  if (doConnection) {
    if (!defines("do", "connections")) return undefined;
    const actionClass = id.endsWith(".send") ? "send" : "draft";
    const result = evaluate({ dimension: "do.connections", target: { connectionId: doConnection, actionClass, onApprovalPath: false } });
    // `approve` is allowed with a person's approval: allowed, with the rule named.
    if (!result.allowed && result.rule?.endsWith("_approval_required")) return { allowed: true, rule: result.rule };
    return result;
  }
  if (id === "do.skills.self_add" || id === "do.skills.runtime_mentions") {
    if (!defines("do", "skills")) return undefined;
    const narrowed = [ceiling?.do?.skills, request?.do?.skills].some((scope) => scope && scope.mode !== "all");
    return narrowed ? { allowed: false, rule: "do.skills.not_listed" } : { allowed: true, rule: null };
  }
  const viaFor: Record<string, "assign" | "mention" | "handoff"> = {
    "talk.agents.assign": "assign",
    "talk.agents.mention": "mention",
    "talk.agents.handoff": "handoff",
  };
  if (viaFor[id]) {
    if (!defines("talk", "agents")) return undefined;
    const sides = [ceiling?.talk?.agents, request?.talk?.agents].filter((scope): scope is NonNullable<typeof scope> => Boolean(scope));
    if (sides.some((scope) => !scope.via.includes(viaFor[id]!))) return { allowed: false, rule: "talk.agents.via_not_allowed" };
    const narrowest = sides.find((scope) => scope.mode !== "any");
    if (!narrowest) return { allowed: true, rule: null };
    return contactAdmitsSome(narrowest, "agent")
      ? { allowed: true, rule: `talk.agents.${narrowest.mode}` }
      : { allowed: false, rule: `talk.agents.${narrowest.mode}` };
  }
  if (id === "talk.people.questions") {
    if (!defines("talk", "people")) return undefined;
    const narrowest = [ceiling?.talk?.people, request?.talk?.people].find((scope) => scope && scope.mode !== "any");
    // The escalation contacts stay reachable whatever the scope says.
    return { allowed: true, rule: narrowest ? `talk.people.${narrowest.mode}` : null };
  }
  if (id === "talk.external.hubspot") {
    if (!defines("talk", "external")) return undefined;
    const hubspot = input.connections.filter((connection) => connection.provider === "hubspot");
    if (hubspot.length === 0) return undefined;
    for (const side of [ceiling, request]) {
      const entries = side?.talk?.external;
      if (!entries) continue;
      const listed = entries.filter((entry) => hubspot.some((connection) => connection.id === entry.connectionId));
      if (listed.length === 0) return { allowed: false, rule: "talk.external.connection_not_listed" };
      const narrowed = listed.find((entry) => entry.targets.mode !== "any");
      if (narrowed) return { allowed: true, rule: `talk.external.${narrowed.targets.mode}` };
    }
    return { allowed: true, rule: null };
  }
  if (id === "talk.inbound.people" || id === "talk.inbound.agents") {
    if (!defines("talk", "inbound")) return undefined;
    const kind = id === "talk.inbound.people" ? "person" : "agent";
    const narrowest = [ceiling?.talk?.inbound, request?.talk?.inbound].find((scope) => scope && scope.mode !== "any");
    if (!narrowest) return { allowed: true, rule: null };
    return contactAdmitsSome(narrowest, kind)
      ? { allowed: true, rule: `talk.inbound.${narrowest.mode}` }
      : { allowed: false, rule: `talk.inbound.${narrowest.mode}` };
  }
  return undefined;
}

/** Set every item's Requested (active revision) and Defined V2 (stored sides). Pure. */
function applyProfileAndAccessV2(items: AgentAccessItem[], input: AgentAccessInventoryInput): AgentAccessItem[] {
  const profile = input.profile ?? null;
  return items.map((item) => {
    let requested: RequestedState = { state: "not_defined" };
    if (profile) {
      const asks = profileRequests(item, profile.access, input);
      requested =
        asks === null
          ? { state: "not_defined", revisionId: profile.activeRevisionId }
          : { state: asks ? "requested" : "not_requested", revisionId: profile.activeRevisionId };
    }
    const v2 = definedV2(item, input);
    return { ...item, requested, ...(v2 ? { defined: { ...item.defined, v2 } } : {}) };
  });
}
