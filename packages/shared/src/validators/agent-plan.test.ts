import { describe, expect, it } from "vitest";
import { isAgentPlanPayload } from "./agent-plan.js";

describe("isAgentPlanPayload", () => {
  const valid = {
    rationale: "We need a CoS to coordinate work.",
    agents: [
      {
        role: "general assistant",
        name: "Sam",
        adapterType: "claude",
        responsibilities: ["scheduling"],
        kpis: ["meeting throughput"],
      },
    ],
    alignmentToShortTerm: "Frees up the founder's time week one.",
    alignmentToLongTerm: "Scales coordination as headcount grows.",
  };

  it("accepts a well-formed plan payload", () => {
    expect(isAgentPlanPayload(valid)).toBe(true);
  });

  it("rejects null and non-object values", () => {
    expect(isAgentPlanPayload(null)).toBe(false);
    expect(isAgentPlanPayload(undefined)).toBe(false);
    expect(isAgentPlanPayload("plan")).toBe(false);
    expect(isAgentPlanPayload(42)).toBe(false);
    expect(isAgentPlanPayload([])).toBe(false);
  });

  it("rejects missing or non-string rationale", () => {
    expect(isAgentPlanPayload({ ...valid, rationale: undefined })).toBe(false);
    expect(isAgentPlanPayload({ ...valid, rationale: 5 })).toBe(false);
  });

  it("rejects missing or non-array agents", () => {
    expect(isAgentPlanPayload({ ...valid, agents: undefined })).toBe(false);
    expect(isAgentPlanPayload({ ...valid, agents: "claude" })).toBe(false);
  });

  it("rejects empty agents array (a plan must propose at least one hire)", () => {
    expect(isAgentPlanPayload({ ...valid, agents: [] })).toBe(false);
  });

  it("rejects missing or non-string alignmentToShortTerm", () => {
    expect(isAgentPlanPayload({ ...valid, alignmentToShortTerm: undefined })).toBe(false);
    expect(isAgentPlanPayload({ ...valid, alignmentToShortTerm: 0 })).toBe(false);
  });

  it("rejects missing or non-string alignmentToLongTerm", () => {
    expect(isAgentPlanPayload({ ...valid, alignmentToLongTerm: undefined })).toBe(false);
    expect(isAgentPlanPayload({ ...valid, alignmentToLongTerm: false })).toBe(false);
  });
});
