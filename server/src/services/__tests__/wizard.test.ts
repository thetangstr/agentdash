import { describe, it, expect } from "vitest";
import { buildWizardMetaPrompt } from "../wizard.js";

describe("wizard service", () => {
  it("generates meta-prompt from wizard input", () => {
    const prompt = buildWizardMetaPrompt({
      purpose: "Handle customer support emails and escalate urgent issues",
      name: "Support Agent",
      tone: "professional",
      role: "general",
    });
    expect(prompt).toContain("Support Agent");
    expect(prompt).toContain("professional");
    expect(prompt).toContain("customer support emails");
    expect(prompt).toContain("SOUL.md");
    expect(prompt).toContain("AGENTS.md");
    expect(prompt).toContain("HEARTBEAT.md");
  });

  it("includes schedule in prompt when provided", () => {
    const prompt = buildWizardMetaPrompt({
      purpose: "Daily marketing summary",
      name: "Marketing Bot",
      tone: "friendly",
      role: "cmo",
      schedule: { frequency: "daily" },
    });
    expect(prompt).toContain("daily");
    expect(prompt).toContain("Marketing Bot");
  });
});
