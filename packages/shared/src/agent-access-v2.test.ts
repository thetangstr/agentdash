import { describe, expect, it } from "vitest";
import {
  AgentAccessPolicyParseError,
  AgentAccessPolicyWriteError,
  accessPolicyReplacementWrite,
  collectAccessV2Clipping,
  definedAccessV2Dimensions,
  evaluateAccessV2,
  mergeAccessPolicyWrite,
  parseAccessPolicy,
  resolveSendPrecedence,
  safeParseAccessPolicy,
  toV1GovernancePolicy,
  type AgentAccessV2Check,
  type AgentAccessV2Context,
} from "./agent-access-v2.js";
import {
  AGENT_ACCESS_V2_DIMENSIONS,
  DEFAULT_AGENT_GOVERNANCE_POLICY,
  normalizeAgentGovernancePolicy,
  type AgentAccessPolicy,
  type AgentAccessPolicyV2Fields,
  type AgentGovernancePolicy,
} from "./types/agent-governance.js";

// AgentDash: Agent Performance Management gate 2 — access policy V2 (access LLD §3).

const AGENT = "00000000-0000-4000-8000-00000000000a";
const MANAGER = "00000000-0000-4000-8000-00000000000b";
const REPORT = "00000000-0000-4000-8000-00000000000c";
const PEER = "00000000-0000-4000-8000-00000000000d";
const PROJECT_A = "00000000-0000-4000-8000-0000000000a1";
const PROJECT_B = "00000000-0000-4000-8000-0000000000a2";
const CONN_A = "00000000-0000-4000-8000-0000000000c1";
const CONN_B = "00000000-0000-4000-8000-0000000000c2";

const V1: AgentGovernancePolicy = {
  permissions: ["tasks:assign", "issues:read"],
  monthlyBudgetCents: 5000,
  destructiveActions: "approval_required",
  dataScopes: ["*"],
  providers: ["hubspot"],
  minimumApproval: "steward",
};

const context: AgentAccessV2Context = {
  agentId: AGENT,
  reportsChain: { managerAgentIds: [MANAGER], directReportAgentIds: [REPORT] },
  escalation: { accountableUserId: "user-accountable", stewardUserId: "user-steward", adminUserIds: ["user-admin"] },
};

function v2(fields: AgentAccessPolicyV2Fields): AgentAccessPolicy {
  return { ...V1, policyVersion: 2, ...fields };
}

describe("parseAccessPolicy", () => {
  it("upgrades a stored V1 row on read without inventing V2 limits", () => {
    const parsed = parseAccessPolicy({ ...V1, permissions: ["issues:read", "tasks:assign", "issues:read"] });
    expect(parsed).toEqual({ ...normalizeAgentGovernancePolicy(V1), policyVersion: 2 });
    expect(definedAccessV2Dimensions(parsed)).toEqual([]);
  });

  it("upgrades the default policy", () => {
    expect(parseAccessPolicy(DEFAULT_AGENT_GOVERNANCE_POLICY)).toEqual({ ...DEFAULT_AGENT_GOVERNANCE_POLICY, policyVersion: 2 });
  });

  it("normalizes a stored V2 row: sorted ids, id lists dropped for predicate modes", () => {
    const parsed = parseAccessPolicy(
      v2({
        see: { projects: { mode: "listed", ids: [PROJECT_B, PROJECT_A, PROJECT_B] } },
        do: { skills: { mode: "all", ids: ["ignored"] } },
        talk: {
          agents: { mode: "reports_chain", agentIds: [PEER], via: ["mention", "assign", "mention"] },
          external: [{ connectionId: CONN_A, targets: { mode: "domains", values: ["Example.COM ", "acme.io"] } }],
        },
      }),
    );
    expect(parsed.see).toEqual({ projects: { mode: "listed", ids: [PROJECT_A, PROJECT_B] } });
    expect(parsed.do).toEqual({ skills: { mode: "all", ids: [] } });
    expect(parsed.talk?.agents).toEqual({ mode: "reports_chain", via: ["assign", "mention"] });
    expect(parsed.talk?.external).toEqual([{ connectionId: CONN_A, targets: { mode: "domains", values: ["acme.io", "example.com"] } }]);
    expect(definedAccessV2Dimensions(parsed)).toEqual(["see.projects", "do.skills", "talk.agents", "talk.external"]);
  });

  it("drops unknown top-level keys and keeps V1 fields intact", () => {
    const parsed = parseAccessPolicy({ ...V1, futureField: true });
    expect(parsed).not.toHaveProperty("futureField");
    expect(toV1GovernancePolicy(parsed)).toEqual(normalizeAgentGovernancePolicy(V1));
  });

  it("rejects values that are neither V1 nor V2", () => {
    expect(() => parseAccessPolicy({ permissions: [] })).toThrow(AgentAccessPolicyParseError);
    expect(() => parseAccessPolicy({ ...V1, policyVersion: 3 })).toThrow(AgentAccessPolicyParseError);
    expect(() => parseAccessPolicy({ ...V1, see: { projects: { mode: "some", ids: [] } } })).toThrow(AgentAccessPolicyParseError);
    const result = safeParseAccessPolicy(null);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe("AGENT_ACCESS_POLICY_INVALID");
  });
});

describe("mergeAccessPolicyWrite", () => {
  const storedV2 = v2({
    see: { projects: { mode: "listed", ids: [PROJECT_A] } },
    talk: { inbound: { mode: "accountable_only" } },
  });

  it("V1 in, V1 out: a legacy write to a V1 row stays byte-identical to today's shape", () => {
    const merged = mergeAccessPolicyWrite(V1, { ...V1, monthlyBudgetCents: 100 });
    expect(merged).toEqual(normalizeAgentGovernancePolicy({ ...V1, monthlyBudgetCents: 100 }));
    expect(merged).not.toHaveProperty("policyVersion");
    expect(Object.keys(merged).sort()).toEqual(Object.keys(V1).sort());
  });

  it("a V1-shaped write to a V2 row replaces the V1 fields and keeps every V2 dimension", () => {
    const merged = mergeAccessPolicyWrite(storedV2, { ...V1, providers: [] });
    expect(merged.providers).toEqual([]);
    expect(merged.policyVersion).toBe(2);
    expect(merged.see).toEqual(storedV2.see);
    expect(merged.talk).toEqual(storedV2.talk);
  });

  it("a V2 write replaces only the dimensions it supplies", () => {
    const merged = mergeAccessPolicyWrite(storedV2, { ...V1, policyVersion: 2, do: { skills: { mode: "listed", ids: ["writing"] } } });
    expect(definedAccessV2Dimensions(merged)).toEqual(["see.projects", "do.skills", "talk.inbound"]);
    const replaced = mergeAccessPolicyWrite(storedV2, { ...V1, see: { projects: { mode: "all", ids: [] } } });
    expect(replaced.see?.projects).toEqual({ mode: "all", ids: [] });
  });

  it("clearing a dimension needs it named; clearing the last one returns the V1 shape", () => {
    const cleared = mergeAccessPolicyWrite(storedV2, { ...V1, clear: ["see.projects"] });
    expect(definedAccessV2Dimensions(cleared)).toEqual(["talk.inbound"]);
    const allCleared = mergeAccessPolicyWrite(storedV2, { ...V1, clear: ["see.projects", "talk.inbound"] });
    expect(allCleared).not.toHaveProperty("policyVersion");
    expect(definedAccessV2Dimensions(allCleared)).toEqual([]);
  });

  it("refuses a write that both supplies and clears a dimension", () => {
    expect(() =>
      mergeAccessPolicyWrite(storedV2, { ...V1, see: { projects: { mode: "all", ids: [] } }, clear: ["see.projects"] }),
    ).toThrow(AgentAccessPolicyWriteError);
  });

  it("treats a missing stored row as empty", () => {
    expect(mergeAccessPolicyWrite(null, V1)).toEqual(normalizeAgentGovernancePolicy(V1));
  });

  it("accessPolicyReplacementWrite names every dimension the next policy drops", () => {
    const next = v2({ do: { skills: { mode: "listed", ids: ["writing"] } } });
    const write = accessPolicyReplacementWrite(storedV2, next);
    expect(write.clear).toEqual(["see.projects", "talk.inbound"]);
    expect(parseAccessPolicy(mergeAccessPolicyWrite(storedV2, write))).toEqual(parseAccessPolicy(next));
    expect(accessPolicyReplacementWrite(null, next)).not.toHaveProperty("clear");
  });
});

describe("evaluateAccessV2 — omitted dimensions restrict nothing", () => {
  const checks: AgentAccessV2Check[] = [
    { dimension: "see.projects", target: { projectId: PROJECT_A } },
    { dimension: "see.connections", target: { connectionId: CONN_A, dataScope: "contacts" } },
    { dimension: "do.connections", target: { connectionId: CONN_A, actionClass: "send", onApprovalPath: false } },
    { dimension: "do.skills", target: { skillKey: "writing" } },
    { dimension: "talk.agents", target: { agentId: PEER }, via: "assign" },
    { dimension: "talk.inbound", target: { kind: "agent", agentId: PEER }, via: "mention" },
    { dimension: "talk.people", target: { userId: "user-anyone", purpose: "question" } },
    { dimension: "talk.external", target: { connectionId: CONN_A, externalTarget: "a@b.com" } },
  ];
  it.each(checks)("$dimension", (check) => {
    expect(evaluateAccessV2(null, null, check, context)).toEqual({ decision: "allow" });
    expect(evaluateAccessV2(V1, parseAccessPolicy(V1), check, context)).toEqual({ decision: "allow" });
  });
  it("every V2 dimension has a check above", () => {
    expect(new Set(checks.map((check) => check.dimension))).toEqual(new Set(AGENT_ACCESS_V2_DIMENSIONS));
  });
});

describe("evaluateAccessV2 — one rule per dimension", () => {
  it("see.projects: listed scopes intersect; the ceiling is reported first", () => {
    const ceiling = { see: { projects: { mode: "listed" as const, ids: [PROJECT_A] } } };
    const request = { see: { projects: { mode: "listed" as const, ids: [PROJECT_B] } } };
    expect(evaluateAccessV2(ceiling, null, { dimension: "see.projects", target: { projectId: PROJECT_A } }, context)).toEqual({
      decision: "allow",
    });
    expect(evaluateAccessV2(ceiling, request, { dimension: "see.projects", target: { projectId: PROJECT_A } }, context)).toMatchObject({
      decision: "refuse",
      rule: "see.projects.not_listed",
      side: "request",
    });
    expect(evaluateAccessV2(ceiling, request, { dimension: "see.projects", target: { projectId: PROJECT_B } }, context)).toMatchObject({
      decision: "refuse",
      side: "ceiling",
      allowedSummary: "1 listed project",
    });
    // `listed` with no ids means nothing; an issue with no project is not restricted by project scopes.
    const nothing = { see: { projects: { mode: "listed" as const, ids: [] } } };
    expect(evaluateAccessV2(nothing, null, { dimension: "see.projects", target: { projectId: PROJECT_A } }, context).decision).toBe("refuse");
    expect(evaluateAccessV2(nothing, null, { dimension: "see.projects", target: { projectId: null } }, context).decision).toBe("allow");
  });

  it("see.connections: connection and data scope must both be listed", () => {
    const ceiling = { see: { connections: [{ connectionId: CONN_A, dataScopes: ["contacts"] }, { connectionId: CONN_B, dataScopes: ["*"] }] } };
    const at = (connectionId: string, dataScope?: string) =>
      evaluateAccessV2(ceiling, null, { dimension: "see.connections", target: { connectionId, dataScope } }, context);
    expect(at(CONN_A, "contacts").decision).toBe("allow");
    expect(at(CONN_A, "deals")).toMatchObject({ decision: "refuse", rule: "see.connections.data_scope_not_listed" });
    expect(at(CONN_B, "deals").decision).toBe("allow");
    expect(at("00000000-0000-4000-8000-0000000000c9")).toMatchObject({ rule: "see.connections.not_listed" });
  });

  it("do.connections: the stricter side wins, an unlisted connection is never, approve refuses only off the approval path", () => {
    const ceiling = { do: { connections: [{ connectionId: CONN_A, draft: "auto" as const, send: "approve" as const }] } };
    const request = { do: { connections: [{ connectionId: CONN_A, draft: "never" as const, send: "auto" as const }] } };
    const send = (onApprovalPath: boolean, legacySendRequirement?: "never" | "approve" | "auto") =>
      evaluateAccessV2(
        ceiling,
        request,
        { dimension: "do.connections", target: { connectionId: CONN_A, actionClass: "send", onApprovalPath } },
        { ...context, legacySendRequirement },
      );
    expect(send(false)).toMatchObject({ decision: "refuse", rule: "do.connections.send_approval_required", side: "ceiling" });
    expect(send(true).decision).toBe("allow");
    // Rules 1–3 already require an approval: the legacy path owns the outcome, V2 adds nothing.
    expect(send(false, "approve").decision).toBe("allow");
    expect(
      evaluateAccessV2(ceiling, request, { dimension: "do.connections", target: { connectionId: CONN_A, actionClass: "draft", onApprovalPath: true } }, context),
    ).toMatchObject({ decision: "refuse", rule: "do.connections.draft_never", side: "request" });
    expect(
      evaluateAccessV2(ceiling, null, { dimension: "do.connections", target: { connectionId: CONN_B, actionClass: "draft", onApprovalPath: true } }, context),
    ).toMatchObject({ decision: "refuse", rule: "do.connections.draft_never", side: "ceiling" });
  });

  it("do.skills: listed scope, with the platform's required skills always allowed", () => {
    const request = { do: { skills: { mode: "listed" as const, ids: ["writing"] } } };
    const run = (skillKey: string, requiredSkillKeys?: string[]) =>
      evaluateAccessV2(null, request, { dimension: "do.skills", target: { skillKey } }, { ...context, requiredSkillKeys });
    expect(run("writing").decision).toBe("allow");
    expect(run("deploy")).toMatchObject({ rule: "do.skills.not_listed", side: "request" });
    expect(run("paperclip", ["paperclip"]).decision).toBe("allow");
  });

  it("talk.agents: via is intersected and contact modes are predicates over the live chain", () => {
    const ceiling = { talk: { agents: { mode: "any" as const, via: ["assign" as const, "mention" as const] } } };
    const request = { talk: { agents: { mode: "reports_chain" as const, via: ["assign" as const, "comment_wake" as const] } } };
    const reach = (agentId: string, via: "assign" | "mention" | "comment_wake" | "handoff") =>
      evaluateAccessV2(ceiling, request, { dimension: "talk.agents", target: { agentId }, via }, context);
    expect(reach(MANAGER, "assign").decision).toBe("allow");
    expect(reach(REPORT, "assign").decision).toBe("allow");
    expect(reach(PEER, "assign")).toMatchObject({ rule: "talk.agents.not_in_reports_chain", side: "request" });
    expect(reach(MANAGER, "mention")).toMatchObject({ rule: "talk.agents.via_not_allowed", side: "request" });
    expect(reach(MANAGER, "comment_wake")).toMatchObject({ rule: "talk.agents.via_not_allowed", side: "ceiling" });
    // Reaching itself is not contact.
    expect(reach(AGENT, "handoff").decision).toBe("allow");
    const listed = { talk: { agents: { mode: "listed" as const, agentIds: [PEER], via: ["assign" as const] } } };
    expect(evaluateAccessV2(listed, null, { dimension: "talk.agents", target: { agentId: PEER }, via: "assign" }, context).decision).toBe("allow");
    const accountableOnly = { talk: { agents: { mode: "accountable_only" as const, via: ["assign" as const] } } };
    expect(
      evaluateAccessV2(accountableOnly, null, { dimension: "talk.agents", target: { agentId: MANAGER }, via: "assign" }, context),
    ).toMatchObject({ rule: "talk.agents.accountable_only" });
  });

  it("talk.inbound: checked on the recipient; configuration authority is never blocked", () => {
    const request = { talk: { inbound: { mode: "accountable_only" as const } } };
    const from = (target: { kind: "agent"; agentId: string } | { kind: "user"; userId: string }, sourceHasConfigurationAuthority = false) =>
      evaluateAccessV2(null, request, { dimension: "talk.inbound", target, via: "assign" }, { ...context, sourceHasConfigurationAuthority });
    expect(from({ kind: "agent", agentId: PEER })).toMatchObject({ rule: "talk.inbound.accountable_only" });
    expect(from({ kind: "user", userId: "user-accountable" }).decision).toBe("allow");
    expect(from({ kind: "user", userId: "user-member" }).decision).toBe("refuse");
    expect(from({ kind: "user", userId: "user-member" }, true).decision).toBe("allow");
    const listed = { talk: { inbound: { mode: "listed" as const, agentIds: [PEER], userIds: ["user-member"] } } };
    expect(evaluateAccessV2(listed, null, { dimension: "talk.inbound", target: { kind: "user", userId: "user-member" }, via: "comment_wake" }, context).decision).toBe("allow");
  });

  it("talk.people: the escalation path is always open; bridge tasks go only to the steward or accountable person", () => {
    const request = { talk: { people: { mode: "listed" as const, userIds: ["user-listed"] } } };
    const ask = (userId: string, purpose: "question" | "approval" | "bridge_task" = "question", policy: AgentAccessPolicyV2Fields | null = request) =>
      evaluateAccessV2(null, policy, { dimension: "talk.people", target: { userId, purpose } }, context);
    expect(ask("user-listed").decision).toBe("allow");
    expect(ask("user-other")).toMatchObject({ rule: "talk.people.not_listed", side: "request" });
    for (const escalation of ["user-accountable", "user-steward", "user-admin"]) {
      expect(ask(escalation, "approval").decision).toBe("allow");
    }
    // Fixed rule, even with no V2 policy at all.
    expect(ask("user-listed", "bridge_task", null)).toMatchObject({ rule: "talk.people.bridge_owner_only", side: "fixed" });
    expect(ask("user-admin", "bridge_task", null).decision).toBe("refuse");
    expect(ask("user-steward", "bridge_task").decision).toBe("allow");
  });

  it("talk.external: listed targets compare case-insensitively; domains match emails and URLs exactly", () => {
    const ceiling = {
      talk: {
        external: [
          { connectionId: CONN_A, targets: { mode: "listed" as const, values: ["Ops@Acme.io"] } },
          { connectionId: CONN_B, targets: { mode: "domains" as const, values: ["acme.io"] } },
        ],
      },
    };
    const send = (connectionId: string, externalTarget: string) =>
      evaluateAccessV2(ceiling, null, { dimension: "talk.external", target: { connectionId, externalTarget } }, context);
    expect(send(CONN_A, "ops@acme.io").decision).toBe("allow");
    expect(send(CONN_A, "sales@acme.io")).toMatchObject({ rule: "talk.external.target_not_listed" });
    expect(send(CONN_B, "Anyone@ACME.io").decision).toBe("allow");
    expect(send(CONN_B, "https://acme.io/hook").decision).toBe("allow");
    expect(send(CONN_B, "x@mail.acme.io")).toMatchObject({ rule: "talk.external.domain_not_listed" });
    expect(send("00000000-0000-4000-8000-0000000000c9", "ops@acme.io")).toMatchObject({ rule: "talk.external.connection_not_listed" });
  });

  it("never allows more than either side: a refusal on one side is not undone by the other", () => {
    const wide = { see: { projects: { mode: "all" as const, ids: [] } } };
    const narrow = { see: { projects: { mode: "listed" as const, ids: [] } } };
    const check: AgentAccessV2Check = { dimension: "see.projects", target: { projectId: PROJECT_A } };
    expect(evaluateAccessV2(wide, narrow, check, context).decision).toBe("refuse");
    expect(evaluateAccessV2(narrow, wide, check, context).decision).toBe("refuse");
  });
});

describe("resolveSendPrecedence — the most restrictive rule wins (access LLD §3.2)", () => {
  it.each([
    [{}, "auto", null],
    [{ accessPolicyV2: "auto" as const }, "auto", null],
    [{ providerMandatesApproval: true, accessPolicyV2: "auto" as const }, "approve", "provider"],
    [{ destructiveActions: "blocked" as const, accessPolicyV2: "approve" as const }, "never", "destructive_actions"],
    [{ destructiveActions: "allowed" as const, connectionAutonomy: "approve" as const }, "approve", "connection_autonomy"],
    [{ connectionAutonomy: "auto" as const, accessPolicyV2: "approve" as const }, "approve", "access_policy_v2"],
    [{ connectionAutonomy: "approve" as const, accessPolicyV2: "never" as const }, "never", "access_policy_v2"],
    // Ties name the earlier rule: the one a person would have to change.
    [{ providerMandatesApproval: true, connectionAutonomy: "approve" as const, accessPolicyV2: "approve" as const }, "approve", "provider"],
  ] as const)("%o → %s (%s)", (layers, requirement, decidedBy) => {
    expect(resolveSendPrecedence(layers)).toEqual({ requirement, decidedBy });
  });
});

describe("collectAccessV2Clipping", () => {
  it("reports what the request asks beyond the ceiling, and nothing for omitted sides", () => {
    const ceiling = v2({
      see: { projects: { mode: "listed", ids: [PROJECT_A] } },
      do: { connections: [{ connectionId: CONN_A, draft: "auto", send: "approve" }] },
      talk: { agents: { mode: "listed", agentIds: [MANAGER], via: ["assign"] }, people: { mode: "listed", userIds: ["u1"] } },
    });
    const request = v2({
      see: { projects: { mode: "listed", ids: [PROJECT_A, PROJECT_B] } },
      do: { connections: [{ connectionId: CONN_A, draft: "auto", send: "auto" }] },
      talk: { agents: { mode: "listed", agentIds: [MANAGER, PEER], via: ["assign", "mention"] }, people: { mode: "reports_chain" } },
    });
    const clips = collectAccessV2Clipping(ceiling, request);
    expect(clips).toEqual([
      { dimension: "see.projects", detail: "Asks for projects the ceiling does not list", values: [PROJECT_B] },
      { dimension: "do.connections", detail: "Asks for less approval than the ceiling requires", values: [`${CONN_A}:send=auto`] },
      { dimension: "talk.agents", detail: "Asks to reach agents the ceiling does not list", values: [PEER] },
      { dimension: "talk.agents", detail: "Asks to reach agents in ways the ceiling does not allow", values: ["mention"] },
      { dimension: "talk.people", detail: 'Asks for "reports_chain" where the ceiling allows "listed"', incomparable: true },
    ]);
    expect(collectAccessV2Clipping(ceiling, v2({}))).toEqual([]);
    expect(collectAccessV2Clipping(null, request)).toEqual([]);
    expect(collectAccessV2Clipping(ceiling, ceiling)).toEqual([]);
  });

  it("asking for all against a listed ceiling is clipped", () => {
    const clips = collectAccessV2Clipping(
      { do: { skills: { mode: "listed", ids: ["writing"] } } },
      { do: { skills: { mode: "all", ids: [] } } },
    );
    expect(clips).toEqual([{ dimension: "do.skills", detail: "Asks for all skills; the ceiling allows 1 listed skill" }]);
  });
});
