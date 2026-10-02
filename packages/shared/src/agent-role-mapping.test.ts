import { describe, expect, it } from "vitest";
import { AGENT_ROLES } from "./constants.js";
import { mapProposedAgentRole, proposedRoleTitle } from "./agent-role-mapping.js";

describe("mapProposedAgentRole", () => {
  it("maps the roles a live CoS plan proposed onto the role enum", () => {
    expect(mapProposedAgentRole("research_analyst")).toBe("researcher");
    expect(mapProposedAgentRole("content_lead")).toBe("cmo");
    expect(mapProposedAgentRole("deployment_lead")).toBe("devops");
    expect(mapProposedAgentRole("sales_support")).toBe("general");
  });

  it("keeps exact enum values and normalizes spacing and case", () => {
    expect(mapProposedAgentRole("qa")).toBe("qa");
    expect(mapProposedAgentRole("Engineer")).toBe("engineer");
    expect(mapProposedAgentRole("Engineering Lead")).toBe("engineer");
    expect(mapProposedAgentRole("Security Engineer")).toBe("security");
    expect(mapProposedAgentRole("UX Researcher")).toBe("designer");
    expect(mapProposedAgentRole("product-manager")).toBe("pm");
    expect(mapProposedAgentRole("Bookkeeper")).toBe("cfo");
  });

  it("never hands out a second chief of staff and falls back to general", () => {
    expect(mapProposedAgentRole("chief_of_staff")).toBe("general");
    expect(mapProposedAgentRole("")).toBe("general");
    expect(mapProposedAgentRole("customer_happiness")).toBe("general");
    expect(mapProposedAgentRole("guide")).toBe("general");
  });

  it("always returns a member of AGENT_ROLES", () => {
    for (const role of ["anything", "growth_hacker", "sre", "data scientist", "ops"]) {
      expect(AGENT_ROLES).toContain(mapProposedAgentRole(role));
    }
  });
});

describe("proposedRoleTitle", () => {
  it("humanizes snake_case roles and keeps free text", () => {
    expect(proposedRoleTitle("research_analyst")).toBe("Research Analyst");
    expect(proposedRoleTitle("qa_lead")).toBe("QA Lead");
    expect(proposedRoleTitle("Head of Growth")).toBe("Head of Growth");
  });
});
