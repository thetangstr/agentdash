import { describe, expect, it } from "vitest";
import { describeAgentKeyProvenance } from "./agent-key-provenance";

describe("describeAgentKeyProvenance (AGE-24)", () => {
  it("names the system for the key minted with the agent, and the person who created the agent", () => {
    expect(describeAgentKeyProvenance({ source: "agent_creation", createdByUserId: null, createdByAgentId: null })).toBe(
      "created with the agent (system)",
    );
    expect(
      describeAgentKeyProvenance({
        source: "agent_creation",
        createdByUserId: "3f2a9c1e-0000-4000-8000-000000000000",
        createdByAgentId: null,
      }),
    ).toBe("created with the agent (system) by user 3f2a9c1e");
  });

  it("distinguishes onboarding, connect codes, and keys a person made by hand", () => {
    expect(describeAgentKeyProvenance({ source: "onboarding" })).toBe("created during onboarding (system)");
    expect(describeAgentKeyProvenance({ source: "connect_code", createdByUserId: "u-1" })).toBe(
      "issued by a connect code by user u-1",
    );
    expect(describeAgentKeyProvenance({ source: "manual", createdByUserId: "u-2" })).toBe("created by user u-2");
    expect(describeAgentKeyProvenance({ source: "manual" })).toBe("created by a person");
  });

  it("does not invent a source it does not know", () => {
    expect(describeAgentKeyProvenance({ source: "something_new" })).toBe("source: something_new");
    expect(describeAgentKeyProvenance({})).toBe("provenance unknown");
  });
});
