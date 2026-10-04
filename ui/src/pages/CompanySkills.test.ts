import { describe, expect, it } from "vitest";
import { isInternalCompanySkill } from "./CompanySkills";

describe("isInternalCompanySkill", () => {
  // AgentDash (c4-polish): bundled development skills ship inside the product
  // (paperclip-dev, terminal-bench-loop) and must not crowd the owner's
  // /ACM/skills list.
  it("marks Paperclip-bundled skills as internal", () => {
    expect(
      isInternalCompanySkill({ sourceBadge: "paperclip", sourceLabel: "Paperclip bundled" }),
    ).toBe(true);
  });

  it("keeps the owner's own Paperclip workspace skills visible", () => {
    expect(
      isInternalCompanySkill({ sourceBadge: "paperclip", sourceLabel: "Paperclip workspace" }),
    ).toBe(false);
  });

  it("keeps every other source visible", () => {
    expect(
      isInternalCompanySkill({ sourceBadge: "github", sourceLabel: "acme/skills" }),
    ).toBe(false);
    expect(
      isInternalCompanySkill({ sourceBadge: "local", sourceLabel: "/opt/skills" }),
    ).toBe(false);
    expect(
      isInternalCompanySkill({ sourceBadge: "paperclip", sourceLabel: null }),
    ).toBe(false);
  });
});
