import { describe, expect, it } from "vitest";
import { isInternalCompanySkill } from "./CompanySkills";

const bundled = { sourceBadge: "paperclip", sourceLabel: "Paperclip bundled" } as const;

describe("isInternalCompanySkill", () => {
  // AgentDash (c4-polish): bundled development skills ship inside the product
  // (paperclip-dev, terminal-bench-loop) and must not crowd the owner's
  // /ACM/skills list.
  it("marks the bundled development skills as internal", () => {
    expect(isInternalCompanySkill({ ...bundled, slug: "paperclip-dev" })).toBe(true);
    expect(isInternalCompanySkill({ ...bundled, slug: "terminal-bench-loop" })).toBe(true);
  });

  it("keeps other bundled skills visible — they are part of the product", () => {
    expect(isInternalCompanySkill({ ...bundled, slug: "diagnose-why-work-stopped" })).toBe(false);
    expect(isInternalCompanySkill({ ...bundled, slug: "paperclip-create-agent" })).toBe(false);
  });

  it("keeps the owner's own Paperclip workspace skills visible", () => {
    expect(
      isInternalCompanySkill({ sourceBadge: "paperclip", sourceLabel: "Paperclip workspace", slug: "paperclip-dev" }),
    ).toBe(false);
  });

  it("keeps every other source visible", () => {
    expect(
      isInternalCompanySkill({ sourceBadge: "github", sourceLabel: "acme/skills", slug: "paperclip-dev" }),
    ).toBe(false);
    expect(
      isInternalCompanySkill({ sourceBadge: "local", sourceLabel: "/opt/skills", slug: "paperclip-dev" }),
    ).toBe(false);
    expect(
      isInternalCompanySkill({ sourceBadge: "paperclip", sourceLabel: null, slug: "paperclip-dev" }),
    ).toBe(false);
  });
});
