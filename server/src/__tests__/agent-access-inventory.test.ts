import { describe, expect, it } from "vitest";
import {
  AGENT_ACCESS_GAP_CODES,
  AGENT_ACCESS_POLICY_VERSION,
  DEFAULT_AGENT_GOVERNANCE_POLICY,
  type ActingAsResult,
  type AgentAccessInventory,
  type AgentAccessPolicy,
  type AgentAccessV2Context,
} from "@paperclipai/shared";
import {
  agentAccessWindow,
  buildAgentAccessInventory,
  buildAgentHostEnvironment,
  type AgentAccessConnectionInput,
  type AgentAccessInventoryInput,
} from "../services/agent-access-inventory.js";

/**
 * AgentDash: Agent Performance Management gate 1. The pure access-inventory
 * builder, fed plain fixtures: every gap code that applies, unknown stays null
 * (never 0), and each mechanism reports the state today's code gives it.
 */

const NOW = new Date("2026-10-29T12:00:00.000Z");
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

function okResult(effectiveAutonomy: "full" | "draft_only" | "blocked", connectionId: string, provider: string): ActingAsResult {
  return {
    ok: true,
    resolution: {
      connectionId,
      provider: provider as never,
      sendIdentity: "service",
      effectiveAutonomy,
      ownerId: AGENT_ID,
      ownerType: "agent",
      accountLabel: null,
    },
  };
}

function connection(overrides: Partial<AgentAccessConnectionInput> = {}): AgentAccessConnectionInput {
  const id = overrides.id ?? "33333333-3333-4333-8333-333333333333";
  const provider = overrides.provider ?? "gmail";
  return {
    id,
    provider,
    ownerType: "agent",
    ownerId: AGENT_ID,
    visibility: "private",
    status: "active",
    accountLabel: "ops@example.test",
    hasToken: true,
    autonomy: { read: "full", draft: "full", send: "draft_only" },
    via: "own",
    resolutions: {
      read: okResult("full", id, provider),
      draft: okResult("full", id, provider),
      send: okResult("draft_only", id, provider),
    },
    ...overrides,
  };
}

function baseInput(overrides: Partial<AgentAccessInventoryInput> = {}): AgentAccessInventoryInput {
  return {
    generatedAt: NOW,
    window: agentAccessWindow(NOW, 30),
    company: { id: COMPANY_ID, productProfile: "default", agentVisibilityDefault: "company" },
    agent: {
      id: AGENT_ID,
      name: "Writer",
      role: "engineer",
      status: "idle",
      pauseReason: null,
      adapterType: "claude_local",
      adapterConfig: {},
      permissions: {},
      defaultEnvironmentId: null,
      visibility: null,
      budgetMonthlyCents: 0,
    },
    environment: null,
    membershipStatus: "active",
    grants: [{ permissionKey: "tasks:assign", scope: null }],
    projects: [],
    steward: { userId: "steward-user", name: "Sam Steward" },
    accountability: { autonomy: "stewarded", userId: "steward-user", via: "steward", name: "Sam Steward" },
    admins: [{ userId: "owner-user", name: "Olive Owner" }],
    activeMemberCount: 3,
    peers: [
      { id: "peer-1", status: "idle", role: "engineer", canCreateAgents: false, hasTaskAssignGrant: true },
      { id: "peer-2", status: "terminated", role: "engineer", canCreateAgents: false, hasTaskAssignGrant: true },
      { id: "peer-3", status: "idle", role: "designer", canCreateAgents: false, hasTaskAssignGrant: false },
    ],
    companySkillCount: 4,
    governance: { onProfile: false, effectivePolicy: null },
    connections: [],
    connectorDefaults: { read: "full", draft: "full", send: "draft_only" },
    agentConnectorOverride: null,
    mandates: [],
    budget: { policy: null, observedCents: 0 },
    handoffsEnabled: false,
    activity: [],
    refusalCounts: [],
    projectsWithheld: false,
    ...overrides,
  };
}

function item(inventory: AgentAccessInventory, id: string) {
  const found = inventory.items.find((entry) => entry.id === id);
  if (!found) throw new Error(`missing item ${id}; have ${inventory.items.map((entry) => entry.id).join(", ")}`);
  return found;
}

function gapCodes(inventory: AgentAccessInventory) {
  return inventory.gaps.map((gap) => gap.code);
}

describe("buildAgentAccessInventory", () => {
  it("states the gate 1 frame: nothing defined by a person, V2 off, one window", () => {
    const inventory = buildAgentAccessInventory(baseInput());
    expect(inventory).toMatchObject({
      kind: "agent_access_inventory",
      version: "agent-access/0",
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      agentName: "Writer",
      generatedAt: NOW.toISOString(),
      profileDefined: false,
      enforcementMode: "off",
      window: { from: "2026-09-29T12:00:00.000Z", to: NOW.toISOString() },
    });
    for (const entry of inventory.items) {
      expect(entry.requested).toEqual({ state: "not_defined" });
    }
    // Every gap code the builder emits is one the contract knows.
    for (const code of gapCodes(inventory)) expect(AGENT_ACCESS_GAP_CODES).toContain(code);
  });

  it("always reports the gaps every agent has today", () => {
    const codes = gapCodes(buildAgentAccessInventory(baseInput()));
    for (const code of [
      "PROFILE_NOT_DEFINED",
      "RUN_CONTEXT_UNCHECKED",
      "SELF_ADD_SKILLS",
      "RUNTIME_SKILL_MENTIONS",
      "SELF_EDIT_CAPABILITIES",
      "ASK_ANY_MEMBER",
      "WAKE_ANY_AGENT",
      "GOVERNANCE_PROFILE_ONLY",
      "HOST_UNRESTRICTED",
    ] as const) {
      expect(codes, code).toContain(code);
    }
    expect(codes).not.toContain("EXPORT_UNSCOPED");
    expect(codes).not.toContain("UNREAD_PERMISSION_SCOPE");
    expect(codes).not.toContain("CONNECTION_NOT_WORKING");
  });

  it("reports open projects as one partial item and each restricted project by the access list", () => {
    const inventory = buildAgentAccessInventory(
      baseInput({
        projects: [
          { id: "p-open", name: "Open", visibility: "company", archived: false, leadAgentId: null, onAccessList: false },
          { id: "p-old", name: "Old", visibility: "company", archived: true, leadAgentId: null, onAccessList: false },
          { id: "p-listed", name: "Listed", visibility: "restricted", archived: false, leadAgentId: null, onAccessList: true },
          { id: "p-lead", name: "Lead only", visibility: "restricted", archived: false, leadAgentId: AGENT_ID, onAccessList: false },
          { id: "p-closed", name: "Closed", visibility: "restricted", archived: false, leadAgentId: null, onAccessList: false },
        ],
      }),
    );
    const open = item(inventory, "see.projects.open");
    expect(open.target).toMatchObject({ kind: "project", count: 2 });
    expect(open.defined).toMatchObject({ allowed: "unrestricted", source: "project_visibility" });
    expect(open.enforced).toEqual({ state: "partial", note: "API reads only; run context and export are not checked" });
    expect(inventory.gaps).toContainEqual(expect.objectContaining({ code: "RUN_CONTEXT_UNCHECKED", itemId: "see.projects.open" }));

    expect(item(inventory, "see.project:p-listed").defined).toMatchObject({ allowed: true, source: "project_access" });
    // Lead is not a read path: only the access list is checked.
    const lead = item(inventory, "see.project:p-lead");
    expect(lead.defined.allowed).toBe(false);
    expect(lead.defined.detail).toMatch(/Lead of this project but not on its access list/);
    expect(item(inventory, "see.project:p-closed").defined.allowed).toBe(false);
    expect(inventory.items.some((entry) => entry.id === "see.project:p-open")).toBe(false);
    expect(open.defined.detail).not.toContain("you can't see");
  });

  it("says, without a count, that restricted projects the viewer can't see are not listed", () => {
    const inventory = buildAgentAccessInventory(
      baseInput({
        projects: [{ id: "p-open", name: "Open", visibility: "company", archived: false, leadAgentId: null, onAccessList: false }],
        projectsWithheld: true,
      }),
    );
    expect(item(inventory, "see.projects.open").defined.detail).toBe("1 project. Restricted projects you can't see are not listed");
    expect(inventory.items.some((entry) => entry.id.startsWith("see.project:"))).toBe(false);
  });

  it("counts refused attempts by code with the projection's rule", () => {
    const inventory = buildAgentAccessInventory(
      baseInput({
        refusalCounts: [
          { action: "authz.refused", reasonCode: "AGENT_CROSS_COMPANY", n: 2 },
          { action: "authz.refused", reasonCode: null, n: 1 },
          { action: "connector_send.refused", reasonCode: null, n: 1 },
        ],
      }),
    );
    expect(inventory.refusalsByCode).toEqual({ AGENT_CROSS_COMPANY: 2, UNSPECIFIED: 1, "connector_send.refused": 1 });
    expect(buildAgentAccessInventory(baseInput()).refusalsByCode).toEqual({});
  });

  it("gives a CEO the export gap and its role-default permissions", () => {
    const inventory = buildAgentAccessInventory(
      baseInput({ agent: { ...baseInput().agent, role: "ceo", permissions: {} }, grants: [] }),
    );
    expect(gapCodes(inventory)).toContain("EXPORT_UNSCOPED");
    expect(item(inventory, "see.company.export").defined).toMatchObject({ allowed: true, source: "role_default" });
    expect(item(inventory, "do.permission:agents:create").defined).toMatchObject({ allowed: true, source: "role_default" });
    expect(item(inventory, "do.permission:tasks:assign").defined).toMatchObject({ allowed: true, source: "role_default" });
    // A CEO agent's company import assigns issues without tasks:assign.
    expect(item(inventory, "talk.agents.assign").enforced.state).toBe("partial");
    expect(item(inventory, "do.capabilities.self_edit").label).toMatch(/other agents/);
  });

  it("reads the legacy canCreateAgents flag as an explicit grant", () => {
    const inventory = buildAgentAccessInventory(
      baseInput({ agent: { ...baseInput().agent, permissions: { canCreateAgents: true } }, membershipStatus: null, grants: [] }),
    );
    const create = item(inventory, "do.permission:agents:create");
    expect(create.defined).toMatchObject({ allowed: true, source: "permission_grant" });
    expect(create.defined.detail).toMatch(/permissions\.canCreateAgents/);
    // The flag does not need a membership row.
    expect(create.working.state).toBe("ok");
  });

  it("flags tasks:assign_scope as unread and grants no route reads for agents as not allowed", () => {
    const inventory = buildAgentAccessInventory(
      baseInput({
        grants: [
          { permissionKey: "tasks:assign", scope: { projectIds: ["x"] } },
          { permissionKey: "tasks:assign_scope", scope: null },
          { permissionKey: "projects:create", scope: null },
        ],
      }),
    );
    expect(inventory.gaps).toContainEqual(
      expect.objectContaining({ code: "UNREAD_PERMISSION_SCOPE", itemId: "do.permission:tasks:assign_scope" }),
    );
    expect(item(inventory, "do.permission:tasks:assign_scope").enforced.state).toBe("not_enforced");
    expect(item(inventory, "do.permission:tasks:assign").enforced.note).toMatch(/scope is stored but never read/);
    const projectsCreate = item(inventory, "do.permission:projects:create");
    expect(projectsCreate.defined.allowed).toBe(false);
    expect(projectsCreate.defined.detail).toMatch(/no route checks projects:create for an agent caller/);
  });

  it("does not honour grants while the agent's membership is inactive", () => {
    const inventory = buildAgentAccessInventory(baseInput({ membershipStatus: "suspended" }));
    const assign = item(inventory, "do.permission:tasks:assign");
    expect(assign.defined.allowed).toBe(false);
    expect(assign.working).toEqual({ state: "not_working", detail: "Agent membership is not active" });
    expect(item(inventory, "talk.agents.assign").defined.allowed).toBe(false);
    expect(gapCodes(inventory).filter((code) => code === "WAKE_ANY_AGENT")).toHaveLength(1);
  });

  it("reports connections from the real resolver, with working from status and draft/send by route", () => {
    const own = connection();
    const hubspot = connection({
      id: "44444444-4444-4444-8444-444444444444",
      provider: "hubspot",
      accountLabel: null,
      via: "workspace",
      visibility: "workspace",
      autonomy: { send: "full" },
      resolutions: {
        read: okResult("full", "44444444-4444-4444-8444-444444444444", "hubspot"),
        draft: okResult("full", "44444444-4444-4444-8444-444444444444", "hubspot"),
        send: okResult("blocked", "44444444-4444-4444-8444-444444444444", "hubspot"),
      },
    });
    const expired = connection({
      id: "55555555-5555-4555-8555-555555555555",
      provider: "slack",
      status: "expired",
      via: "workspace",
      resolutions: null,
    });
    const inventory = buildAgentAccessInventory(
      baseInput({
        connections: [own, hubspot, expired],
        agentConnectorOverride: { send: "blocked" },
      }),
    );

    const ownRead = item(inventory, `see.connection:${own.id}`);
    expect(ownRead.defined).toMatchObject({ allowed: true, source: "connector_resolution" });
    expect(ownRead.working).toEqual({ state: "ok" });
    // Off the profile the provider and data-scope ceilings do not run.
    expect(ownRead.enforced.state).toBe("profile_only");

    // Gmail draft/send refuse agents whatever the autonomy says.
    const gmailDraft = item(inventory, `do.connection:${own.id}.draft`);
    expect(gmailDraft.defined.allowed).toBe(false);
    expect(gmailDraft.defined.detail).toMatch(/refuses agent callers/);
    expect(gmailDraft.working.state).toBe("not_applicable");

    // HubSpot send has a route; the agent override wins the autonomy chain.
    const hubspotSend = item(inventory, `do.connection:${hubspot.id}.send`);
    expect(hubspotSend.defined.detail).toMatch(/send autonomy blocked \(workspace draft_only → connection full → agent override blocked\)/);
    expect(hubspotSend.defined.detail).toMatch(/connector_send approval/);

    const expiredRead = item(inventory, `see.connection:${expired.id}`);
    expect(expiredRead.working).toEqual({ state: "not_working", detail: "expired" });
    expect(inventory.gaps).toContainEqual(
      expect.objectContaining({ code: "CONNECTION_NOT_WORKING", itemId: `see.connection:${expired.id}` }),
    );
  });

  it("marks a document connection without a credential as not working", () => {
    const doc = connection({ provider: "microsoft", via: "steward_document", ownerType: "user", ownerId: "steward-user", hasToken: false, resolutions: null });
    const inventory = buildAgentAccessInventory(baseInput({ connections: [doc] }));
    expect(item(inventory, `see.connection:${doc.id}`).working).toEqual({ state: "not_working", detail: "missing its credential" });
  });

  it("reports the governance policy's effective fields on the MK profile and drops the profile gap", () => {
    const policy = { ...DEFAULT_AGENT_GOVERNANCE_POLICY, providers: ["hubspot"], monthlyBudgetCents: 50_00 };
    const inventory = buildAgentAccessInventory(
      baseInput({
        company: { id: COMPANY_ID, productProfile: "agentdash_mk", agentVisibilityDefault: "company" },
        governance: { onProfile: true, effectivePolicy: policy },
      }),
    );
    expect(gapCodes(inventory)).not.toContain("GOVERNANCE_PROFILE_ONLY");
    const governance = item(inventory, "do.governance");
    expect(governance.defined.detail).toContain("providers: hubspot");
    expect(governance.defined.detail).toContain("monthlyBudgetCents: 5000 ($50.00)");
    expect(governance.enforced.state).toBe("profile_only");
    expect(item(inventory, "spend.governance_budget").defined).toMatchObject({ allowed: true, source: "governance_policy" });
    expect(item(inventory, "talk.external.hubspot").defined.allowed).toBe(true);
    expect(item(inventory, "talk.external.hubspot").working.state).toBe("not_working");
  });

  it("keeps HubSpot unavailable off the profile and Gmail and Slack unavailable to agents", () => {
    const inventory = buildAgentAccessInventory(baseInput());
    expect(item(inventory, "talk.external.hubspot").defined.allowed).toBe(false);
    expect(item(inventory, "talk.external.hubspot").enforced.state).toBe("profile_only");
    expect(item(inventory, "talk.external.gmail").defined.allowed).toBe(false);
    expect(item(inventory, "talk.external.slack").defined.allowed).toBe(false);
    expect(inventory.items.some((entry) => entry.id === "spend.governance_budget")).toBe(false);
  });

  it("counts reachable agents and who can assign to this one, with unknown left null", () => {
    const inventory = buildAgentAccessInventory(baseInput());
    expect(item(inventory, "talk.agents.assign").target).toMatchObject({ kind: "agent", count: 2 });
    expect(item(inventory, "talk.inbound.agents").target).toMatchObject({ count: 1 });
    expect(item(inventory, "talk.inbound.people").target).toMatchObject({ count: 3 });
    expect(item(inventory, "talk.people.questions").target).toMatchObject({ kind: "person", count: 3 });

    const hidden = buildAgentAccessInventory(baseInput({ agent: { ...baseInput().agent, visibility: "owner" } }));
    // Owner-only visibility narrows who can assign; that count is not computed, so it is null, not 0.
    expect(item(hidden, "talk.inbound.people").target?.count).toBeNull();
  });

  it("counts uses only where an activity maps to an item, and never infers a use from silence", () => {
    const lastAt = new Date("2026-10-28T09:00:00.000Z");
    const inventory = buildAgentAccessInventory(
      baseInput({
        handoffsEnabled: true,
        activity: [
          { action: "agent.skills_synced", entityId: AGENT_ID, interactionKind: null, reasonCode: null, capabilitiesChanged: false, count: 2, lastAt },
          { action: "agent.skills_synced", entityId: "peer-1", interactionKind: null, reasonCode: null, capabilitiesChanged: false, count: 5, lastAt },
          { action: "agent.updated", entityId: AGENT_ID, interactionKind: null, reasonCode: null, capabilitiesChanged: false, count: 7, lastAt },
          { action: "issue.thread_interaction_created", entityId: "issue-1", interactionKind: "ask_user_questions", reasonCode: null, capabilitiesChanged: false, count: 3, lastAt },
          { action: "issue.thread_interaction_created", entityId: "issue-1", interactionKind: "suggest_tasks", reasonCode: null, capabilitiesChanged: false, count: 9, lastAt },
          { action: "issue.agent_handoff", entityId: "issue-2", interactionKind: null, reasonCode: null, capabilitiesChanged: false, count: 1, lastAt },
          { action: "issue.agent_handoff_refused", entityId: "issue-2", interactionKind: null, reasonCode: null, capabilitiesChanged: false, count: 1, lastAt },
          { action: "authz.refused", entityId: COMPANY_ID, interactionKind: null, reasonCode: "AGENT_CROSS_COMPANY", capabilitiesChanged: false, count: 4, lastAt },
          { action: "authz.refused", entityId: COMPANY_ID, interactionKind: null, reasonCode: "BOARD_ACCESS_REQUIRED", capabilitiesChanged: false, count: 6, lastAt },
        ],
      }),
    );
    expect(item(inventory, "do.skills.self_add").used).toEqual({ state: "used", uses: 2, refusals: 0, lastAt: lastAt.toISOString() });
    // agent.updated without a capabilities change is not a capabilities edit.
    expect(item(inventory, "do.capabilities.self_edit").used).toEqual({ state: "not_observed", uses: 0, refusals: 0, lastAt: null });
    expect(item(inventory, "talk.people.questions").used).toMatchObject({ state: "used", uses: 3 });
    expect(item(inventory, "talk.agents.handoff").used).toMatchObject({ state: "used_and_refused", uses: 1, refusals: 1 });
    // A company-boundary refusal maps to the boundary; uses of it are not recorded.
    expect(item(inventory, "see.company").used).toEqual({ state: "refused", uses: null, refusals: 4, lastAt: lastAt.toISOString() });
    // Unmapped items stay unknown with null counts, never 0.
    for (const id of ["see.projects.open", "talk.agents.assign", "talk.agents.mention", "do.permission:tasks:assign"]) {
      expect(item(inventory, id).used, id).toEqual({ state: "unknown", uses: null, refusals: null, lastAt: null });
    }
  });

  it("leaves hand-off use unknown while hand-off recording is off and nothing was recorded", () => {
    const inventory = buildAgentAccessInventory(baseInput({ handoffsEnabled: false }));
    expect(item(inventory, "talk.agents.handoff").used.state).toBe("unknown");
    expect(item(inventory, "talk.agents.handoff").enforced.note).toMatch(/coworker_bridge_enabled is off/);
  });

  it("reports the monthly budget, its hard stop and spent versus budget", () => {
    const under = buildAgentAccessInventory(
      baseInput({ budget: { policy: { amount: 10_000, windowKind: "calendar_month_utc", hardStopEnabled: true }, observedCents: 2_500 } }),
    );
    expect(item(under, "spend.budget")).toMatchObject({
      defined: { allowed: true, source: "budget_policy" },
      enforced: { state: "enforced" },
      working: { state: "ok", detail: "Spent $25.00 of $100.00 this month (UTC)" },
    });

    const over = buildAgentAccessInventory(
      baseInput({ budget: { policy: { amount: 10_000, windowKind: "calendar_month_utc", hardStopEnabled: true }, observedCents: 12_000 } }),
    );
    expect(item(over, "spend.budget").working.state).toBe("not_working");

    const warnOnly = buildAgentAccessInventory(
      baseInput({ budget: { policy: { amount: 10_000, windowKind: "calendar_month_utc", hardStopEnabled: false }, observedCents: 0 } }),
    );
    expect(item(warnOnly, "spend.budget").enforced.state).toBe("not_enforced");

    const none = buildAgentAccessInventory(
      baseInput({ agent: { ...baseInput().agent, budgetMonthlyCents: 3_000 }, budget: { policy: null, observedCents: 100 } }),
    );
    const noBudget = item(none, "spend.budget");
    expect(noBudget.defined.allowed).toBe("unrestricted");
    expect(noBudget.defined.detail).toMatch(/nothing enforces it/);
    expect(noBudget.enforced.state).toBe("not_enforced");
  });

  it("lists active mandates as partial", () => {
    const expiresAt = new Date("2026-11-30T00:00:00.000Z");
    const inventory = buildAgentAccessInventory(
      baseInput({
        mandates: [{ id: "m-1", grantorAgentId: "peer-1", grantorName: "Buyer", scope: ["book_travel"], permissionKey: "travel:book", spendCapCents: 150_000, expiresAt }],
      }),
    );
    expect(item(inventory, "do.mandate:m-1")).toMatchObject({
      label: "Act under a mandate from Buyer",
      defined: { allowed: true, source: "mandate", detail: `scope: book_travel; permission: travel:book; cap: $1500.00; expires: ${expiresAt.toISOString()}` },
      enforced: { state: "partial" },
    });
  });

  it("names who is always reachable once each, by name and never by email", () => {
    const inventory = buildAgentAccessInventory(
      baseInput({
        admins: [
          { userId: "owner-user", name: "Olive Owner" },
          { userId: "steward-user", name: "Sam Steward" },
          { userId: "nameless", name: null },
        ],
      }),
    );
    expect(inventory.alwaysReachable).toEqual([
      { kind: "user", id: "steward-user", label: "Sam Steward", role: "steward" },
      { kind: "user", id: "owner-user", label: "Olive Owner", role: "admin" },
      { kind: "user", id: "nameless", label: "A company member", role: "admin" },
    ]);

    const autonomous = buildAgentAccessInventory(
      baseInput({ steward: null, accountability: { autonomy: "autonomous", userId: "acct-user", via: "assignment", name: "Ada" } }),
    );
    expect(autonomous.alwaysReachable[0]).toEqual({ kind: "user", id: "acct-user", label: "Ada", role: "accountable" });
  });
});

// AgentDash (APM gate 2, P2.3): Requested from the active profile revision,
// Defined V2 from the stored sides, the mode from the company setting.
describe("buildAgentAccessInventory — gate 2 profile and V2", () => {
  const REVISION_ID = "44444444-4444-4444-8444-444444444444";
  const CONN_ID = "55555555-5555-4555-8555-555555555555";
  const OTHER_CONN_ID = "66666666-6666-4666-8666-666666666666";

  function access(v2: Partial<AgentAccessPolicy> = {}): AgentAccessPolicy {
    return { ...DEFAULT_AGENT_GOVERNANCE_POLICY, policyVersion: AGENT_ACCESS_POLICY_VERSION, ...v2 };
  }

  const context: AgentAccessV2Context = {
    agentId: AGENT_ID,
    reportsChain: { managerAgentIds: [], directReportAgentIds: [] },
    escalation: { accountableUserId: null, stewardUserId: "steward-user", adminUserIds: ["owner-user"] },
  };

  const projects = [
    { id: "p-open", name: "Open", visibility: "company", archived: false, leadAgentId: null, onAccessList: false },
    { id: "p-other", name: "Other", visibility: "company", archived: false, leadAgentId: null, onAccessList: false },
    { id: "p-listed", name: "Listed", visibility: "restricted", archived: false, leadAgentId: null, onAccessList: true },
  ];

  it("reads Requested from the active revision, names it, and drops the not-defined gap", () => {
    const inventory = buildAgentAccessInventory(
      baseInput({
        projects,
        connections: [connection({ id: CONN_ID })],
        enforcementMode: "shadow",
        profile: {
          activeRevisionId: REVISION_ID,
          access: access({
            see: { projects: { mode: "listed", ids: ["p-open"] } },
            do: { skills: { mode: "listed", ids: [] }, connections: [{ connectionId: CONN_ID, draft: "auto", send: "never" }] },
            talk: { agents: { mode: "any", via: ["assign"] } },
          }),
        },
      }),
    );
    expect(inventory.profileDefined).toBe(true);
    expect(inventory.enforcementMode).toBe("shadow");
    expect(gapCodes(inventory)).not.toContain("PROFILE_NOT_DEFINED");
    const requested = (id: string) => item(inventory, id).requested;
    expect(requested("see.company")).toEqual({ state: "requested", revisionId: REVISION_ID });
    expect(requested("see.project:p-listed")).toEqual({ state: "not_requested", revisionId: REVISION_ID });
    expect(requested("see.projects.open")).toEqual({ state: "not_requested", revisionId: REVISION_ID });
    expect(requested(`do.connection:${CONN_ID}.draft`)).toEqual({ state: "requested", revisionId: REVISION_ID });
    expect(requested(`do.connection:${CONN_ID}.send`)).toEqual({ state: "not_requested", revisionId: REVISION_ID });
    expect(requested("do.skills.self_add")).toEqual({ state: "not_requested", revisionId: REVISION_ID });
    expect(requested("do.capabilities.self_edit")).toEqual({ state: "not_requested", revisionId: REVISION_ID });
    expect(requested("do.permission:tasks:assign")).toEqual({ state: "requested", revisionId: REVISION_ID });
    expect(requested("talk.agents.assign")).toEqual({ state: "requested", revisionId: REVISION_ID });
    expect(requested("talk.agents.mention")).toEqual({ state: "not_requested", revisionId: REVISION_ID });
    // No profile field covers it: still not defined, but the revision is named.
    expect(requested("see.agent_memory")).toEqual({ state: "not_defined", revisionId: REVISION_ID });
  });

  it("an omitted V2 dimension in the profile requests today's access", () => {
    const inventory = buildAgentAccessInventory(
      baseInput({ projects, profile: { activeRevisionId: REVISION_ID, access: access() } }),
    );
    expect(item(inventory, "see.projects.open").requested.state).toBe("requested");
    expect(item(inventory, "see.project:p-listed").requested.state).toBe("requested");
    expect(item(inventory, "do.skills.runtime_mentions").requested.state).toBe("requested");
  });

  it("reports Defined V2 per item from the stored sides, and nothing where V2 is silent", () => {
    const inventory = buildAgentAccessInventory(
      baseInput({
        projects,
        connections: [connection({ id: CONN_ID }), connection({ id: OTHER_CONN_ID, accountLabel: "b@example.test" })],
        accessPolicy: {
          ceiling: access({ see: { projects: { mode: "listed", ids: ["p-open", "p-listed"] } } }),
          request: access({
            see: { connections: [{ connectionId: CONN_ID, dataScopes: ["*"] }] },
            do: { connections: [{ connectionId: CONN_ID, draft: "approve", send: "never" }], skills: { mode: "listed", ids: ["a"] } },
            talk: { agents: { mode: "listed", agentIds: [], via: ["assign"] }, people: { mode: "accountable_only" } },
          }),
          context,
        },
      }),
    );
    const v2 = (id: string) => item(inventory, id).defined.v2;
    expect(v2("see.project:p-listed")).toEqual({ allowed: true, rule: null });
    expect(v2("see.projects.open")).toEqual({ allowed: false, rule: "see.projects.not_listed" });
    expect(v2(`see.connection:${CONN_ID}`)).toEqual({ allowed: true, rule: null });
    expect(v2(`see.connection:${OTHER_CONN_ID}`)).toEqual({ allowed: false, rule: "see.connections.not_listed" });
    expect(v2(`do.connection:${CONN_ID}.draft`)).toEqual({ allowed: true, rule: "do.connections.draft_approval_required" });
    expect(v2(`do.connection:${CONN_ID}.send`)).toEqual({ allowed: false, rule: "do.connections.send_never" });
    expect(v2(`do.connection:${OTHER_CONN_ID}.send`)).toEqual({ allowed: false, rule: "do.connections.send_never" });
    expect(v2("do.skills.self_add")).toEqual({ allowed: false, rule: "do.skills.not_listed" });
    expect(v2("talk.agents.assign")).toEqual({ allowed: false, rule: "talk.agents.listed" });
    expect(v2("talk.agents.mention")).toEqual({ allowed: false, rule: "talk.agents.via_not_allowed" });
    expect(v2("talk.people.questions")).toEqual({ allowed: true, rule: "talk.people.accountable_only" });
    // Silent dimensions carry no v2 at all, and the legacy fields are untouched.
    expect(v2("talk.inbound.agents")).toBeUndefined();
    expect(v2("spend.budget")).toBeUndefined();
    expect(item(inventory, "see.projects.open").defined).toMatchObject({ allowed: "unrestricted", source: "project_visibility" });
    // Requested stays not_defined without an active revision, and the mode defaults to off.
    expect(item(inventory, "see.projects.open").requested).toEqual({ state: "not_defined" });
    expect(inventory.enforcementMode).toBe("off");
    expect(inventory.profileDefined).toBe(false);
  });

  it("is byte-identical to gate 1 output when no profile, no V2 policy and mode off", () => {
    const gate1 = buildAgentAccessInventory(baseInput({ projects }));
    const gate2 = buildAgentAccessInventory(baseInput({ projects, profile: null, accessPolicy: null, enforcementMode: "off" }));
    expect(gate2).toEqual(gate1);
    for (const entry of gate2.items) expect(entry.defined.v2).toBeUndefined();
  });
});

describe("buildAgentHostEnvironment", () => {
  const agent = baseInput().agent;

  it("reads claude_local's default as prompts skipped on the local machine", () => {
    expect(buildAgentHostEnvironment({ agent, environment: null })).toEqual({
      adapterType: "claude_local",
      kind: "local_host",
      hostPermissionsRestricted: false,
      environmentId: null,
      detail: "Local machine, host permissions not restricted: permission prompts skipped (dangerouslySkipPermissions)",
    });
  });

  it("reads an explicit dangerouslySkipPermissions: false as restricted, with no host gap", () => {
    const restricted = { ...agent, adapterConfig: { dangerouslySkipPermissions: false } };
    expect(buildAgentHostEnvironment({ agent: restricted, environment: null }).hostPermissionsRestricted).toBe(true);
    const inventory = buildAgentAccessInventory(baseInput({ agent: restricted }));
    expect(gapCodes(inventory)).not.toContain("HOST_UNRESTRICTED");
  });

  it("treats a non-local default environment as managed", () => {
    const env = buildAgentHostEnvironment({
      agent: { ...agent, defaultEnvironmentId: "env-1" },
      environment: { id: "env-1", name: "Build box", driver: "ssh", status: "active" },
    });
    expect(env).toMatchObject({ kind: "managed_environment", environmentId: "env-1" });
    expect(env.detail).toContain('Managed environment "Build box" (ssh)');
  });

  it("treats a default environment on the local driver as the local machine", () => {
    const env = buildAgentHostEnvironment({
      agent: { ...agent, defaultEnvironmentId: "env-local" },
      environment: { id: "env-local", name: "Local", driver: "local", status: "active" },
    });
    expect(env).toMatchObject({ kind: "local_host", environmentId: "env-local", hostPermissionsRestricted: false });
  });

  it("does not guess for remote and unverified adapters", () => {
    expect(buildAgentHostEnvironment({ agent: { ...agent, adapterType: "http" }, environment: null })).toMatchObject({
      kind: "remote",
      hostPermissionsRestricted: "unknown",
    });
    expect(buildAgentHostEnvironment({ agent: { ...agent, adapterType: "claude_api" }, environment: null })).toMatchObject({
      kind: "unknown",
      hostPermissionsRestricted: "unknown",
    });
    expect(buildAgentHostEnvironment({ agent: { ...agent, adapterType: "codex_local" }, environment: null })).toMatchObject({
      kind: "local_host",
      hostPermissionsRestricted: "unknown",
    });
    expect(
      buildAgentHostEnvironment({ agent: { ...agent, adapterType: "acpx_local", adapterConfig: { permissionMode: "deny-all" } }, environment: null }),
    ).toMatchObject({ kind: "local_host", hostPermissionsRestricted: true });
  });
});

describe("agentAccessWindow", () => {
  it("ends at the observation time and starts N whole days earlier", () => {
    expect(agentAccessWindow(NOW, 1)).toEqual({ from: new Date("2026-10-28T12:00:00.000Z"), to: NOW });
    expect(agentAccessWindow(NOW, 365).from.toISOString()).toBe("2025-10-29T12:00:00.000Z");
  });
});
