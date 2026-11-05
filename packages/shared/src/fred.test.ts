import { describe, expect, it } from "vitest";
import * as shared from "./index.js";

// Test through the public package surface so missing exports cannot hide.
const contracts = shared as unknown as Record<string, { safeParse: (input: unknown) => { success: boolean }; parse: (input: unknown) => unknown }>;
const setup = { adapterType: "claude_local", budgetMonthlyCents: 1000, shareWithCompany: true };
const brief = { expectedRevision: 0, goal: "Reduce proposal preparation effort", firstJob: "Prepare one source-backed brief", successCriteria: ["Cite the approved company source"], baseline: "Unknown", target: "Agree after the first job", outcomeWindow: "After the first accepted job", boundaries: "No outreach", shareWithCompany: true };

describe("Fred owner contracts", () => {
  it("exports strict owner setup, brief and start contracts", () => {
    expect(contracts.fredSetupSchema).toBeDefined();
    expect(contracts.fredBriefSchema).toBeDefined();
    expect(contracts.fredStartSchema).toBeDefined();
  });
  it("requires explicit company sharing and a positive bounded budget", () => {
    expect(contracts.fredSetupSchema.safeParse(setup).success).toBe(true);
    for (const budgetMonthlyCents of [0, -1, 1.5, Infinity, 100_000_001]) {
      expect(contracts.fredSetupSchema.safeParse({ ...setup, budgetMonthlyCents }).success).toBe(false);
    }
    expect(contracts.fredSetupSchema.safeParse({ ...setup, shareWithCompany: false }).success).toBe(false);
    expect(contracts.fredSetupSchema.safeParse({ ...setup, shareWithCompany: undefined }).success).toBe(false);
  });
  it("refuses caller-controlled principal identity, config and unsupported harnesses", () => {
    for (const extra of [{ agentId: "fake" }, { ownerUserId: "other" }, { adapterConfig: { dangerouslySkipPermissions: true } }, { apiKey: "secret" }]) {
      expect(contracts.fredSetupSchema.safeParse({ ...setup, ...extra }).success).toBe(false);
    }
    expect(contracts.fredSetupSchema.safeParse({ ...setup, adapterType: "process" }).success).toBe(false);
  });
  it("retains an explicit unknown baseline instead of inventing a number", () => {
    expect(contracts.fredBriefSchema.safeParse(brief).success).toBe(true);
    expect(contracts.fredBriefSchema.parse({ ...brief, goal: "  A useful goal  " })).toMatchObject({ goal: "A useful goal", baseline: "Unknown" });
  });
  it("requires versioned actionable brief criteria and does not accept an owner verdict", () => {
    for (const patch of [{ expectedRevision: -1 }, { expectedRevision: 0.5 }, { goal: "  " }, { firstJob: "" }, { successCriteria: [] }, { successCriteria: [""] }, { successCriteria: Array.from({ length: 13 }, () => "Criterion") }, { accepted: true }]) {
      expect(contracts.fredBriefSchema.safeParse({ ...brief, ...patch }).success).toBe(false);
    }
  });
  it("binds start to the saved registration and current brief revision", () => {
    const valid = { registrationId: "a43c3e71-bbba-4ea8-a49c-75c4568717d0", expectedRevision: 1 };
    expect(contracts.fredStartSchema.safeParse(valid).success).toBe(true);
    expect(contracts.fredStartSchema.safeParse({ ...valid, registrationId: "Fred" }).success).toBe(false);
    expect(contracts.fredStartSchema.safeParse({ ...valid, expectedRevision: 0 }).success).toBe(false);
    expect(contracts.fredStartSchema.safeParse({ ...valid, skipApproval: true }).success).toBe(false);
  });
});
