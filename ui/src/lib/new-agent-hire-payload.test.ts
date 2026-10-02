// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildNewAgentHirePayload } from "./new-agent-hire-payload";
import { defaultCreateValues } from "../components/agent-config-defaults";

describe("buildNewAgentHirePayload", () => {
  it("persists the selected default environment id", () => {
    expect(
      buildNewAgentHirePayload({
        name: "Linux Claude",
        effectiveRole: "general",
        configValues: {
          ...defaultCreateValues,
          adapterType: "claude_local",
          defaultEnvironmentId: "11111111-1111-4111-8111-111111111111",
        },
        adapterConfig: { foo: "bar" },
      }),
    ).toMatchObject({
      name: "Linux Claude",
      role: "general",
      adapterType: "claude_local",
      defaultEnvironmentId: "11111111-1111-4111-8111-111111111111",
      adapterConfig: { foo: "bar" },
      budgetMonthlyCents: 0,
    });
  });

  it("sends null when no default environment is selected", () => {
    expect(
      buildNewAgentHirePayload({
        name: "Local Claude",
        effectiveRole: "general",
        configValues: {
          ...defaultCreateValues,
          adapterType: "claude_local",
        },
        adapterConfig: {},
      }),
    ).toMatchObject({
      defaultEnvironmentId: null,
    });
  });

  it("can require a launch-safe harness preflight before creating the agent", () => {
    expect(
      buildNewAgentHirePayload({
        name: "Launch Agent",
        effectiveRole: "general",
        configValues: {
          ...defaultCreateValues,
          adapterType: "codex_local",
        },
        adapterConfig: { model: "gpt-5.5" },
        requireHarnessPreflight: true,
      }),
    ).toMatchObject({
      requireHarnessPreflight: true,
    });
  });
  it('carries a selected workforce role without replacing human instructions or capabilities', () => {
    expect(buildNewAgentHirePayload({ name: 'Mira', effectiveRole: 'general', workforceTemplateId: 'sales-support', configValues: defaultCreateValues, adapterConfig: { instructions: 'Keep my custom instructions' } })).toMatchObject({ workforceTemplateId: 'sales-support', adapterConfig: { instructions: 'Keep my custom instructions' }, role: 'general' });
  });


  // AgentDash (Scan 3, lane J): "What it should do" travels as capabilities.
  it("sends the trimmed capabilities and omits blank ones", () => {
    const base = {
      name: "Helper",
      effectiveRole: "general",
      configValues: { ...defaultCreateValues, adapterType: "hermes_local" },
      adapterConfig: {},
    };
    expect(
      buildNewAgentHirePayload({ ...base, capabilities: "  Answer customer emails  " }),
    ).toMatchObject({ capabilities: "Answer customer emails" });
    expect(buildNewAgentHirePayload({ ...base, capabilities: "   " })).not.toHaveProperty("capabilities");
    expect(buildNewAgentHirePayload(base)).not.toHaveProperty("capabilities");
  });
});
