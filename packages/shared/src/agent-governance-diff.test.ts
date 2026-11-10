import { describe, expect, it } from "vitest";
import { diffGovernancePolicies } from "./agent-governance-diff.js";
import { computeEffectiveAgentPolicy, DEFAULT_AGENT_GOVERNANCE_POLICY, type AgentGovernancePolicy } from "./types/agent-governance.js";

/** AgentDash admin powers: gains and losses, shared by the batch preview and the UI. */

const base: AgentGovernancePolicy = {
  permissions: ["tasks:assign", "agents:create"],
  monthlyBudgetCents: 100_00,
  destructiveActions: "approval_required",
  dataScopes: ["crm"],
  providers: ["slack"],
  minimumApproval: "steward",
};

describe("diffGovernancePolicies", () => {
  it("is empty for the same policy", () => {
    expect(diffGovernancePolicies(base, { ...base })).toEqual({ gains: [], losses: [] });
  });

  it("budget: more is a gain, less a loss, and the unlimited sentinel reads as no limit", () => {
    expect(diffGovernancePolicies(base, { ...base, monthlyBudgetCents: 200_00 }).gains).toEqual([{ field: "monthlyBudgetCents", text: "Budget: up to $200 a month (was up to $100 a month)" }]);
    expect(diffGovernancePolicies(DEFAULT_AGENT_GOVERNANCE_POLICY, { ...DEFAULT_AGENT_GOVERNANCE_POLICY, monthlyBudgetCents: 500_00 }).losses[0]!.text).toBe("Budget: up to $500 a month (was no limit)");
  });

  it("lists: added entries are gains, removed ones losses; any → some is a loss, some → any a gain", () => {
    const diff = diffGovernancePolicies(base, { ...base, providers: ["teams"] });
    expect(diff.gains).toEqual([{ field: "providers", text: "Providers: adds teams" }]);
    expect(diff.losses).toEqual([{ field: "providers", text: "Providers: loses slack" }]);
    expect(diffGovernancePolicies({ ...base, dataScopes: ["*"] }, base).losses).toEqual([{ field: "dataScopes", text: "Data: only crm (was any)" }]);
    expect(diffGovernancePolicies(base, { ...base, permissions: ["*"] }).gains).toEqual([{ field: "permissions", text: "Permissions: any (was agents:create, tasks:assign)" }]);
  });

  it("destructive actions: looser is a gain; minimum approval: lower is a gain", () => {
    expect(diffGovernancePolicies(base, { ...base, destructiveActions: "blocked" }).losses[0]!.text).toBe("Actions that cannot be undone: never (was only with approval)");
    expect(diffGovernancePolicies(base, { ...base, destructiveActions: "allowed" }).gains[0]!.field).toBe("destructiveActions");
    expect(diffGovernancePolicies(base, { ...base, minimumApproval: "none" }).gains[0]!.text).toBe("Approval: no approval needed (was its steward approves)");
    expect(diffGovernancePolicies({ ...base, minimumApproval: "none" }, base).losses[0]!.field).toBe("minimumApproval");
  });

  it("reads the clamped result: a template tighter than the request only loses what the agent actually had", () => {
    const request: AgentGovernancePolicy = { ...DEFAULT_AGENT_GOVERNANCE_POLICY, monthlyBudgetCents: 50_00, providers: ["slack", "teams"] };
    const before = computeEffectiveAgentPolicy(DEFAULT_AGENT_GOVERNANCE_POLICY, request);
    const after = computeEffectiveAgentPolicy({ ...DEFAULT_AGENT_GOVERNANCE_POLICY, monthlyBudgetCents: 200_00, providers: ["slack"] }, request);
    const diff = diffGovernancePolicies(before, after);
    // The request's $50 is already below the template's $200: no budget change.
    expect(diff.losses).toEqual([{ field: "providers", text: "Providers: loses teams" }]);
    expect(diff.gains).toEqual([]);
  });
});
