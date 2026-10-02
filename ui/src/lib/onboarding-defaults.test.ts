import { describe, expect, it } from "vitest";
import {
  DEFAULT_TASK_DESCRIPTION,
  DEFAULT_TASK_TITLE,
  WIZARD_DEFAULT_ADAPTER_TYPE,
  isRecommendedWizardAdapter,
} from "./onboarding-defaults";

// AgentDash (scan 2, E6): plain language in the onboarding wizard.
describe("onboarding defaults", () => {
  it("speaks to the owner's agent in the owner's voice, not about 'the operator'", () => {
    expect(`${DEFAULT_TASK_TITLE}\n${DEFAULT_TASK_DESCRIPTION}`).not.toMatch(/operator/i);
    expect(DEFAULT_TASK_TITLE).toBe("Get oriented and tell me how to use you");
    // The e2e onboarding spec checks the issue carries this opening line.
    expect(DEFAULT_TASK_DESCRIPTION.startsWith("You are the Chief of Staff (CoS).")).toBe(true);
  });

  it("recommends exactly one way to run the agent: the preselected default", () => {
    const cards = ["claude_local", "codex_local", "hermes_local"];
    expect(cards.filter(isRecommendedWizardAdapter)).toEqual([WIZARD_DEFAULT_ADAPTER_TYPE]);
  });
});
