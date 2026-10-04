// AgentDash (review-1028, item 8): the run-healer's fallback suggestion —
// what an operator-configured chain or the built-in table WOULD move a
// hermes_local agent to — must resolve the tiers from env and must not
// suggest another tier model on the same provider when the token plan
// itself is down.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { suggestHealerFallbackTarget } from "./fixer.js";

const ENV_KEYS = [
  "AGENTDASH_FALLBACK_CHAIN",
  "AGENTDASH_HERMES_MODEL_TIERS",
  "HERMES_PROFILES_DIR",
  "AGENTDASH_HERMES_ROOT",
  "AGENTDASH_HERMES_PROFILE_TEMPLATE",
  "AGENTDASH_HERMES_HIGH_MODEL",
  "AGENTDASH_HERMES_HIGH_PROVIDER",
  "AGENTDASH_HERMES_LOW_MODEL",
  "AGENTDASH_HERMES_LOW_PROVIDER",
] as const;

describe("suggestHealerFallbackTarget", () => {
  let profilesDir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    // The BYOK marker path must point at an empty dir — a dev box's real
    // ~/.hermes could hold a marker and flip the gate test-dependent.
    profilesDir = mkdtempSync(join(tmpdir(), "hermes-healer-test-"));
    process.env.HERMES_PROFILES_DIR = profilesDir;
    delete process.env.AGENTDASH_HERMES_ROOT;
    delete process.env.AGENTDASH_HERMES_PROFILE_TEMPLATE;
    delete process.env.AGENTDASH_FALLBACK_CHAIN;
    process.env.AGENTDASH_HERMES_MODEL_TIERS = "on";
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    rmSync(profilesDir, { recursive: true, force: true });
  });

  it("suggests the OTHER tier when a hermes_local agent fails off the tier provider", () => {
    // An agent on a person's own provider failing is a model problem — the
    // tier hops are the closest real move.
    expect(
      suggestHealerFallbackTarget({
        adapterType: "hermes_local",
        model: "deepseek-v4-flash",
        provider: "zai",
      }),
    ).toBe("hermes_local:qwen3.8-max-0902");
    // A modelless hermes agent the same way.
    expect(
      suggestHealerFallbackTarget({
        adapterType: "hermes_local",
        model: "",
        provider: "",
      }),
    ).toBe("hermes_local:qwen3.8-max-0902");
  });

  it("never suggests a tier model when tiers are inactive — cross-provider instead", () => {
    process.env.AGENTDASH_HERMES_MODEL_TIERS = "off";
    expect(
      suggestHealerFallbackTarget({
        adapterType: "hermes_local",
        model: "",
        provider: "",
      }),
    ).toBe("claude_api");
  });

  it("skips every tier-model hop when the token-plan provider itself is down (item 8)", () => {
    // The agent's provider IS the tier provider and it failed — a different
    // model on the same provider is the same call again. Whether the agent
    // sits on the high tier, the low tier, or no model at all, the
    // suggestion must cross providers instead.
    for (const model of ["qwen3.8-max-0902", "deepseek-v4-flash", ""]) {
      expect(
        suggestHealerFallbackTarget({
          adapterType: "hermes_local",
          model,
          provider: "alibaba-token-plan-cn",
        }),
        `model=${model || "<none>"}`,
      ).toBe("claude_api");
    }
    // The skip follows the env-resolved provider, not the shipped id.
    process.env.AGENTDASH_HERMES_HIGH_PROVIDER = "alibaba-custom";
    process.env.AGENTDASH_HERMES_LOW_PROVIDER = "alibaba-custom";
    expect(
      suggestHealerFallbackTarget({
        adapterType: "hermes_local",
        model: "qwen3.8-max-0902",
        provider: "alibaba-custom",
      }),
    ).toBe("claude_api");
  });

  it("still hops within-hermes when the failing provider is NOT the tiers'", () => {
    // A hermes agent on a person's own provider failing is a model problem,
    // not a token-plan outage — the tier hops remain the closest move.
    expect(
      suggestHealerFallbackTarget({
        adapterType: "hermes_local",
        model: "glm-5.3-flash",
        provider: "zai",
      }),
    ).toBe("hermes_local:qwen3.8-max-0902");
  });

  it("honours env-resolved tier models in the suggestions", () => {
    process.env.AGENTDASH_HERMES_HIGH_MODEL = "qwen-next";
    process.env.AGENTDASH_HERMES_HIGH_PROVIDER = "alibaba-custom";
    expect(
      suggestHealerFallbackTarget({
        adapterType: "hermes_local",
        model: "deepseek-v4-flash",
        provider: "zai",
      }),
    ).toBe("hermes_local:qwen-next");
  });

  it("lets an operator-configured AGENTDASH_FALLBACK_CHAIN take precedence", () => {
    process.env.AGENTDASH_FALLBACK_CHAIN = "hermes_local:k3,hermes_local:glm-5.3";
    expect(
      suggestHealerFallbackTarget({
        adapterType: "hermes_local",
        model: "k3",
        provider: "",
      }),
    ).toBe("hermes_local:glm-5.3");
  });
});
