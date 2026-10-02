import { describe, expect, it } from "vitest";
import { AGENT_ROLES, mapProposedAgentRole } from "@paperclipai/shared";
import { defaultPermissionsForRole } from "../services/agent-permissions.js";

// Review of #991: plan hires are mapped onto AGENT_ROLES by keyword. That is
// only safe while a role is a label: every role except ceo must default to
// the same permissions, and the plan mapper must never reach ceo. If a role
// ever gains authority, this fails and the mapper needs a fresh review.
describe("default agent permissions by role", () => {
  const baseline = defaultPermissionsForRole("general");

  it.each(AGENT_ROLES.filter((role) => role !== "ceo"))("gives %s the same defaults as general", (role) => {
    expect(defaultPermissionsForRole(role)).toEqual(baseline);
  });

  it("gives an unknown role the same defaults as general", () => {
    expect(defaultPermissionsForRole("month_end_close_coordinator")).toEqual(baseline);
  });

  it("keeps ceo as the only role with extra authority", () => {
    expect(defaultPermissionsForRole("ceo")).not.toEqual(baseline);
    expect(baseline.canCreateAgents).toBe(false);
  });

  it("never maps a plan role onto ceo", () => {
    for (const title of ["CEO", "Chief Executive Officer", "Month End Close Coordinator", "Billing Engineer", "ceo"]) {
      expect(mapProposedAgentRole(title)).not.toBe("ceo");
    }
  });
});
