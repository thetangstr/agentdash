import { describe, expect, it } from "vitest";
import { AGENT_ROLES } from "./constants.js";
import { PRIVILEGED_PLAN_ROLES, mapProposedAgentRole, proposedRoleTitle } from "./agent-role-mapping.js";

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

  // Review of #953: a model-written plan role must never reach a role that
  // carries authority (ceo has canCreateAgents and company-wide access).
  it("maps every privileged role, in any spelling, to general", () => {
    for (const role of [
      "ceo",
      "CEO",
      " Ceo ",
      "chief_executive_officer",
      "Chief Executive Officer",
      "CEO & founder",
      "acting-ceo",
      "chief_of_staff",
      "Chief of Staff",
      "CHIEF-OF-STAFF",
    ]) {
      expect(mapProposedAgentRole(role)).toBe("general");
    }
  });

  it("never returns a privileged role for any input", () => {
    const inputs = [...AGENT_ROLES, "ceo_assistant", "chief", "executive", "founder", "owner", "admin", "board"];
    for (const input of inputs) {
      expect(PRIVILEGED_PLAN_ROLES.has(mapProposedAgentRole(input))).toBe(false);
    }
  });

  it("keeps the privileged wording as the title", () => {
    expect(proposedRoleTitle("ceo")).toBe("CEO");
    expect(proposedRoleTitle("chief_of_staff")).toBe("Chief Of Staff");
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
