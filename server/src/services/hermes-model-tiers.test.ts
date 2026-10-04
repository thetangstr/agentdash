// AgentDash (review-1028, item 1): the instance gate for the model tiers —
// opt-in switch AND no BYOK marker. The marker check reads the same
// `agentdash-provider.json` `configureHermesProvider` writes into the
// Hermes template profile, so the tests point HERMES_PROFILES_DIR at a
// temp directory rather than touching a real Hermes home.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyHermesModelTierIfActive,
  hermesModelTierStamp,
  hermesModelTiersActive,
  stampPlanModelTiers,
} from "./hermes-model-tiers.js";

const tempDirs: string[] = [];

function makeEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "hermes-tiers-test-"));
  tempDirs.push(dir);
  const profilesDir = join(dir, "profiles");
  mkdirSync(profilesDir, { recursive: true });
  return {
    AGENTDASH_HERMES_ROOT: join(dir, ".hermes"),
    HERMES_PROFILES_DIR: profilesDir,
    AGENTDASH_HERMES_PROFILE_TEMPLATE: "agentdash",
    ...overrides,
  };
}

function writeByokMarker(env: NodeJS.ProcessEnv, provider = "zai") {
  const dir = join(env.HERMES_PROFILES_DIR as string, "agentdash");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "agentdash-provider.json"),
    JSON.stringify({
      companyId: "company-1",
      provider,
      model: "glm-5.3-flash",
      configuredAt: new Date().toISOString(),
    }),
  );
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("hermesModelTiersActive", () => {
  it("is inactive by default — the switch is opt-in", () => {
    const env = makeEnv();
    expect(hermesModelTiersActive(env)).toBe(false);
    expect(hermesModelTiersActive(makeEnv({ AGENTDASH_HERMES_MODEL_TIERS: "off" }))).toBe(false);
    expect(hermesModelTiersActive(makeEnv({ AGENTDASH_HERMES_MODEL_TIERS: "yes" }))).toBe(false);
  });

  it("is active with AGENTDASH_HERMES_MODEL_TIERS=on and no BYOK marker", () => {
    expect(hermesModelTiersActive(makeEnv({ AGENTDASH_HERMES_MODEL_TIERS: "on" }))).toBe(true);
  });

  it("is inactive with the switch on when the box holds a company's own key", () => {
    const env = makeEnv({ AGENTDASH_HERMES_MODEL_TIERS: "on" });
    writeByokMarker(env, "zai");
    expect(hermesModelTiersActive(env)).toBe(false);
    writeByokMarker(env, "openrouter");
    expect(hermesModelTiersActive(env)).toBe(false);
    writeByokMarker(env, "anthropic");
    expect(hermesModelTiersActive(env)).toBe(false);
    writeByokMarker(env, "openai");
    expect(hermesModelTiersActive(env)).toBe(false);
  });
});

describe("applyHermesModelTierIfActive", () => {
  it("leaves the config untouched when the switch is off — the pre-tier behaviour", () => {
    const env = makeEnv();
    const result = applyHermesModelTierIfActive({
      adapterType: "hermes_local",
      adapterConfig: {},
      role: "chief_of_staff",
      env,
    });
    expect(result.appliedTier).toBeNull();
    expect(result.adapterConfig).toEqual({});
  });

  it("applies the tier when the switch is on and no BYOK marker exists", () => {
    const result = applyHermesModelTierIfActive({
      adapterType: "hermes_local",
      adapterConfig: {},
      role: "chief_of_staff",
      env: makeEnv({ AGENTDASH_HERMES_MODEL_TIERS: "on" }),
    });
    expect(result.appliedTier).toBe("high");
    expect(result.adapterConfig).toEqual({
      model: "qwen3.8-max-0902",
      provider: "alibaba-token-plan-cn",
    });
  });

  it("never applies on a BYOK box even with the switch on", () => {
    const env = makeEnv({ AGENTDASH_HERMES_MODEL_TIERS: "on" });
    writeByokMarker(env);
    const result = applyHermesModelTierIfActive({
      adapterType: "hermes_local",
      adapterConfig: {},
      role: "ceo",
      env,
    });
    expect(result.appliedTier).toBeNull();
    expect(result.adapterConfig).toEqual({});
  });
});

describe("hermesModelTierStamp", () => {
  const onEnv = () => makeEnv({ AGENTDASH_HERMES_MODEL_TIERS: "on" });

  it("is null when the tiers are inactive or the adapter is not hermes_local", () => {
    expect(
      hermesModelTierStamp({ adapterType: "hermes_local", role: "ceo", env: makeEnv() }),
    ).toBeNull();
    expect(
      hermesModelTierStamp({ adapterType: "claude_local", role: "ceo", env: onEnv() }),
    ).toBeNull();
  });

  it("mirrors the hire mapping — privileged wording maps through the title", () => {
    // A plan's "CEO" hires as role `general` (privileged), keeping the
    // title — the stamp resolves the tier exactly like materialization.
    expect(
      hermesModelTierStamp({ adapterType: "hermes_local", role: "CEO", env: onEnv() }),
    ).toEqual({ modelTier: "high", model: "qwen3.8-max-0902" });
    expect(
      hermesModelTierStamp({ adapterType: "hermes_local", role: "reviewer", env: onEnv() }),
    ).toEqual({ modelTier: "low", model: "deepseek-v4-flash" });
  });

  it("stamps env-resolved overrides", () => {
    const env = makeEnv({
      AGENTDASH_HERMES_MODEL_TIERS: "on",
      AGENTDASH_HERMES_LOW_MODEL: "deepseek-v5-flash",
      AGENTDASH_HERMES_LOW_PROVIDER: "alibaba-custom",
    });
    expect(
      hermesModelTierStamp({ adapterType: "hermes_local", role: "engineer", env }),
    ).toEqual({ modelTier: "low", model: "deepseek-v5-flash" });
  });
});

describe("stampPlanModelTiers", () => {
  const plan = {
    rationale: "r",
    alignmentToShortTerm: "s",
    alignmentToLongTerm: "l",
    agents: [
      {
        role: "chief_of_staff",
        name: "Ava",
        title: "Chief of Staff",
        adapterType: "hermes_local" as const,
        responsibilities: [],
        kpis: [],
      },
      {
        role: "engineer",
        name: "Bo",
        adapterType: "hermes_local" as const,
        responsibilities: [],
        kpis: [],
      },
      {
        role: "engineer",
        name: "Cy",
        adapterType: "claude_local" as const,
        responsibilities: [],
        kpis: [],
      },
    ],
  };

  it("returns the payload untouched when the tiers are inactive", () => {
    delete process.env.AGENTDASH_HERMES_MODEL_TIERS;
    const stamped = stampPlanModelTiers(plan);
    expect(stamped).toBe(plan);
  });

  it("stamps the resolved tier+model on each hermes_local agent only", () => {
    // stampPlanModelTiers reads process.env, so the BYOK marker check must
    // point at an empty temp dir — a dev box's real ~/.hermes could hold a
    // marker and make this test environment-dependent.
    const env = makeEnv({ AGENTDASH_HERMES_MODEL_TIERS: "on" });
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try {
      const stamped = stampPlanModelTiers(plan);
      expect(stamped.agents[0]).toMatchObject({ modelTier: "high", model: "qwen3.8-max-0902" });
      expect(stamped.agents[1]).toMatchObject({ modelTier: "low", model: "deepseek-v4-flash" });
      expect(stamped.agents[2]).not.toHaveProperty("modelTier");
      expect(stamped).not.toBe(plan);
    } finally {
      for (const key of Object.keys(env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});
