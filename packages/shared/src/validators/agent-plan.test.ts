import { describe, expect, it } from "vitest";
import { isAgentPlanPayload } from "./agent-plan.js";

describe("isAgentPlanPayload", () => {
  const validAgent = {
    role: "general assistant",
    name: "Sam",
    adapterType: "claude_local",
    responsibilities: ["scheduling"],
    kpis: ["meeting throughput"],
  };
  const valid = {
    rationale: "We need a CoS to coordinate work.",
    agents: [validAgent],
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

  // Closes #231: per-agent + adapterType allowlist tests.
  describe("per-agent validation (#231)", () => {
    it("accepts each whitelisted adapterType", () => {
      const allowed = ["claude_local", "codex_local", "gemini_local", "opencode_local", "pi_local"];
      for (const adapterType of allowed) {
        expect(
          isAgentPlanPayload({ ...valid, agents: [{ ...validAgent, adapterType }] }),
        ).toBe(true);
      }
    });

    it("rejects unknown adapterType (prompt-injection guard)", () => {
      expect(
        isAgentPlanPayload({ ...valid, agents: [{ ...validAgent, adapterType: "evil_local" }] }),
      ).toBe(false);
      expect(
        isAgentPlanPayload({ ...valid, agents: [{ ...validAgent, adapterType: "" }] }),
      ).toBe(false);
      expect(
        isAgentPlanPayload({ ...valid, agents: [{ ...validAgent, adapterType: 42 }] }),
      ).toBe(false);
    });

    it("rejects an agent with empty role or name", () => {
      expect(
        isAgentPlanPayload({ ...valid, agents: [{ ...validAgent, role: "" }] }),
      ).toBe(false);
      expect(
        isAgentPlanPayload({ ...valid, agents: [{ ...validAgent, name: "" }] }),
      ).toBe(false);
    });

    it("rejects an agent missing responsibilities or kpis", () => {
      expect(
        isAgentPlanPayload({ ...valid, agents: [{ ...validAgent, responsibilities: undefined }] }),
      ).toBe(false);
      expect(
        isAgentPlanPayload({ ...valid, agents: [{ ...validAgent, kpis: "throughput" }] }),
      ).toBe(false);
    });

    it("rejects the WHOLE plan if a single agent is malformed", () => {
      expect(
        isAgentPlanPayload({
          ...valid,
          agents: [validAgent, { ...validAgent, adapterType: "evil_local" }],
        }),
      ).toBe(false);
    });
  });
});
