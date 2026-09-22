import { describe, expect, it } from "vitest";
import { resolveAgentRuntimeModel } from "./agent-runtime-model.js";

/**
 * AGE-1 regression: agent-model reporting must resolve the way heartbeat
 * resolves, and must NEVER fall back to the instance-level adapter preset
 * (`AGENTDASH_DEFAULT_ADAPTER` / `/api/health.adapterPreset`). An explicit
 * unknown beats a confidently wrong answer.
 */

const HERMES_LOCAL = "hermes_local";

describe("resolveAgentRuntimeModel", () => {
  it("reports the explicit adapterConfig model with adapter_config source", async () => {
    const resolved = await resolveAgentRuntimeModel(
      {
        adapterType: HERMES_LOCAL,
        adapterConfig: { model: "glm-5.3-flash" },
      },
      {
        readProfileConfig: async () => {
          throw new Error("must not consult the profile when a model is explicit");
        },
        detectHostModel: async () => {
          throw new Error("must not consult the host default when a model is explicit");
        },
      },
    );
    expect(resolved).toEqual({ model: "glm-5.3-flash", provider: "zai", source: "adapter_config" });
  });

  // THE regression: a hermes_local agent with NO explicit model, on a host
  // whose env preset says minimax, resolves the hermes-configured model —
  // the preset is instance state and must never leak into agent reporting.
  it("hermes_local with no explicit model reports the profile model, not MiniMax or the env preset", async () => {
    const resolved = await resolveAgentRuntimeModel(
      {
        adapterType: HERMES_LOCAL,
        adapterConfig: {},
        agentId: "CDAACB4E-CC28-4A8C-BE92-6DEF6853A6DA",
      },
      {
        readProfileConfig: async (profileName: string) => {
          expect(profileName).toBe("agentdash-cdaacb4ecc284a8cbe926def6853a6da");
          return ["model:", "  default: k3", "  provider: openrouter", ""].join("\n");
        },
        detectHostModel: async () => {
          throw new Error("must not consult the host default when the profile answers");
        },
        env: {
          AGENTDASH_DEFAULT_ADAPTER: "minimax",
          AGENTDASH_HERMES_MANAGED_PROFILES: "true",
        } as NodeJS.ProcessEnv,
      },
    );
    expect(resolved).toEqual({ model: "k3", provider: "openrouter", source: "agent_profile" });
  });

  it("falls through to the hermes host default when managed profiles are off and the profile is unreadable", async () => {
    const host = { model: "glm-5.3-flash", provider: "zai" };
    const off = await resolveAgentRuntimeModel(
      { adapterType: HERMES_LOCAL, adapterConfig: {}, agentId: "abc" },
      {
        readProfileConfig: async () => null,
        detectHostModel: async () => host,
        env: { AGENTDASH_HERMES_MANAGED_PROFILES: "false", AGENTDASH_DEFAULT_ADAPTER: "minimax" } as NodeJS.ProcessEnv,
      },
    );
    expect(off).toEqual({ model: "glm-5.3-flash", provider: "zai", source: "hermes_host_default" });

    const noFlag = await resolveAgentRuntimeModel(
      { adapterType: HERMES_LOCAL, adapterConfig: {}, agentId: "abc" },
      { readProfileConfig: async () => null, detectHostModel: async () => host },
    );
    expect(noFlag).toEqual({ model: "glm-5.3-flash", provider: "zai", source: "hermes_host_default" });
  });

  it("explicit adapterConfig.provider wins over profile and inference", async () => {
    const resolved = await resolveAgentRuntimeModel(
      { adapterType: HERMES_LOCAL, adapterConfig: { provider: "auto" }, agentId: "abc" },
      {
        readProfileConfig: async () => ["model:", "  default: k3", "  provider: openrouter"].join("\n"),
        detectHostModel: async () => null,
        env: { AGENTDASH_HERMES_MANAGED_PROFILES: "true" } as NodeJS.ProcessEnv,
      },
    );
    expect(resolved).toEqual({ model: "k3", provider: "auto", source: "agent_profile" });
  });

  it("reports an explicit unknown — never the env preset — when nothing is readable", async () => {
    const resolved = await resolveAgentRuntimeModel(
      { adapterType: HERMES_LOCAL, adapterConfig: {}, agentId: "abc" },
      {
        readProfileConfig: async () => null,
        detectHostModel: async () => null,
        env: {
          AGENTDASH_DEFAULT_ADAPTER: "minimax",
          AGENTDASH_HERMES_MANAGED_PROFILES: "true",
        } as NodeJS.ProcessEnv,
      },
    );
    expect(resolved).toEqual({ model: null, provider: null, source: "unknown" });
  });

  it("does not read hermes state for non-hermes adapters", async () => {
    const resolved = await resolveAgentRuntimeModel(
      { adapterType: "claude_local", adapterConfig: {} },
      {
        readProfileConfig: async () => {
          throw new Error("claude agents have no hermes profile");
        },
        detectHostModel: async () => {
          throw new Error("claude agents have no hermes host default");
        },
        env: { AGENTDASH_DEFAULT_ADAPTER: "minimax" } as NodeJS.ProcessEnv,
      },
    );
    expect(resolved).toEqual({ model: null, provider: null, source: "unknown" });
  });
});
