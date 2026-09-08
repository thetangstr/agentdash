import { describe, expect, it } from "vitest";
import {
  resolveAgentRuntimeModelSync,
  type AgentRuntimeModelDeps,
} from "./agent-runtime-model.js";

/**
 * AGE-1 regression coverage: an agent's *reported* runtime model must be the
 * model that will actually serve it, never the instance-level AgentDash env
 * preset (AGENTDASH_DEFAULT_ADAPTER etc.), and "no choice" must read as an
 * explicit unknown rather than a stale instance value.
 */
describe("resolveAgentRuntimeModelSync", () => {
  const baseInput = {
    adapterType: "hermes_local",
    adapterConfig: {} as Record<string, unknown>,
    agentId: "11111111-2222-3333-4444-555555555555",
    hermesManagedProfilesEnabled: false,
  };

  function deps(overrides: Partial<AgentRuntimeModelDeps> = {}): AgentRuntimeModelDeps {
    return {
      env: { AGENTDASH_DEFAULT_ADAPTER: "minimax", MINIMAX_API_KEY: "sk-test" },
      readFile: async () => {
        throw new Error("no hermes config on disk in this test");
      },
      detectHostModel: async () => null,
      ...overrides,
    };
  }

  it("reports an explicit adapterConfig.model verbatim and never reads the env preset", async () => {
    const result = await resolveAgentRuntimeModelSync(
      { ...baseInput, adapterConfig: { model: "zai/glm-5.3-flash" } },
      deps(),
    );
    expect(result).toEqual({
      model: "zai/glm-5.3-flash",
      provider: "zai",
      source: "agent_adapter_config",
    });
  });

  it("hermes_local with no explicit model reports the hermes profile model, not MiniMax or the env preset", async () => {
    // The whole point of AGE-1: AGENTDASH_DEFAULT_ADAPTER=minimax is in the
    // environment, and the reported model must still be the one hermes would
    // actually load — here, the per-agent profile's glm-5.3-flash.
    const profileYaml = [
      "model:",
      "  default: glm-5.3-flash",
      "  provider: zai",
      "",
    ].join("\n");
    const result = await resolveAgentRuntimeModelSync(
      { ...baseInput, hermesManagedProfilesEnabled: true },
      deps({
        readFile: async (path) => {
          if (path.includes("agentdash-11111111222233334444555555555555")) {
            return profileYaml;
          }
          throw new Error("unexpected read");
        },
      }),
    );
    expect(result.model ?? "").toBe("glm-5.3-flash");
    expect(result.provider).toBe("zai");
    expect(result.source).toBe("agent_hermes_profile");
    expect((result.model ?? "").toLowerCase()).not.toContain("minimax");
  });

  it("falls back to the hermes host default when no profile exists", async () => {
    // "k3" matches no provider prefix hint, so the adapter chain resolves
    // "auto" — the same pair a real run of this instance reported (run
    // d886008e: usage.model=k3, usage.provider=auto). Reporting auto verbatim
    // is the honest answer: hermes picks at run time.
    const result = await resolveAgentRuntimeModelSync(
      { ...baseInput, hermesManagedProfilesEnabled: true },
      deps({
        detectHostModel: async () => ({ model: "k3", provider: "" }),
      }),
    );
    expect(result.model ?? "").toBe("k3");
    expect(result.provider).toBe("auto");
    expect(result.source).toBe("hermes_host_default");
  });

  it("reports an explicit unknown when nothing is resolvable — never the env preset", async () => {
    const result = await resolveAgentRuntimeModelSync(baseInput, deps());
    expect(result).toEqual({ model: null, provider: "unknown", source: "hermes_host_default" });
    expect(result.model ?? "").not.toContain("minimax");
  });

  it("prefers the profile config over the host default when managed profiles are on", async () => {
    const result = await resolveAgentRuntimeModelSync(
      { ...baseInput, hermesManagedProfilesEnabled: true },
      deps({
        readFile: async (path) => {
          if (path.includes("agentdash-11111111222233334444555555555555")) {
            return "model:\n  default: profile-model\n  provider: zai\n";
          }
          throw new Error("unexpected read");
        },
        detectHostModel: async () => ({ model: "host-model", provider: "" }),
      }),
    );
    expect(result.model ?? "").toBe("profile-model");
    expect(result.source).toBe("agent_hermes_profile");
  });
});
