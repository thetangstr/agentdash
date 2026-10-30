import { describe, expect, it } from "vitest";
import { agentScenarioManifestV1Schema, hirePayloadNamesProfile, parseAgentScenarioManifestDocument } from "./agent-brief.js";

// AgentDash: APM gate 5 (P5.1) — the scenario manifest's shape and parse rules.

const scenario = {
  key: "s01",
  title: "Weekly renewal digest",
  stakeholders: "",
  currentProcess: "",
  removedOrNewWork: "",
  triggerCadence: "",
  inputsSources: "",
  deliverable: "",
  acceptanceNotes: "",
  authorityNeeds: "",
  escalation: "",
  baselineMeasure: "",
  unknowns: [],
  recommendation: "human_owned",
  reason: "Pricing stays with people",
};

describe("AgentScenarioManifestV1", () => {
  it("parses JSON or one fenced json block", () => {
    const json = JSON.stringify({ manifestVersion: 1, scenarios: [scenario] });
    expect(parseAgentScenarioManifestDocument(json)).toMatchObject({ ok: true });
    expect(parseAgentScenarioManifestDocument("```json\n" + json + "\n```\n")).toMatchObject({ ok: true });
    expect(parseAgentScenarioManifestDocument("# Notes\n" + json)).toMatchObject({ ok: false });
  });

  it("ties the target to the recommendation", () => {
    const check = (patch: Record<string, unknown>) =>
      agentScenarioManifestV1Schema.safeParse({ manifestVersion: 1, scenarios: [{ ...scenario, ...patch }] }).success;
    const id = "00000000-0000-4000-8000-000000000001";
    expect(check({ recommendation: "reuse" })).toBe(false);
    expect(check({ recommendation: "reuse", targetAgentId: id })).toBe(true);
    expect(check({ recommendation: "bounded_change", targetAgentId: id })).toBe(true);
    expect(check({ recommendation: "new_role", targetAgentId: id })).toBe(false);
    expect(check({ recommendation: "new_role", unboundProfileId: id })).toBe(true);
    expect(check({ recommendation: "new_role" })).toBe(true);
    expect(check({ recommendation: "deterministic_workflow", unboundProfileId: id })).toBe(false);
    expect(check({ reason: "" })).toBe(false);
    expect(check({ extra: true })).toBe(false);
  });

  it("refuses duplicate scenario keys and other versions", () => {
    expect(agentScenarioManifestV1Schema.safeParse({ manifestVersion: 1, scenarios: [scenario, scenario] }).success).toBe(false);
    expect(agentScenarioManifestV1Schema.safeParse({ manifestVersion: 2, scenarios: [] }).success).toBe(false);
  });

  it("recognises a hire payload that names a profile", () => {
    expect(hirePayloadNamesProfile({ name: "x" })).toBe(false);
    expect(hirePayloadNamesProfile({ name: "x", profileRevisionId: "y" })).toBe(true);
    expect(hirePayloadNamesProfile(null)).toBe(false);
  });
});
