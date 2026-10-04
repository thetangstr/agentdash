import { describe, expect, it } from "vitest";
import {
  AGENT_MODEL_TIER_METADATA_KEY,
  applyHermesModelTierDefault,
  describeHermesModel,
  HERMES_LOCAL_ADAPTER_TYPE,
  HERMES_MODEL_TIERS,
  hermesModelDisplayName,
  hermesModelTierForModel,
  hermesModelTierLabel,
  hermesModelTiersEnabled,
  hermesTierOverrideWarnings,
  modelTierForRole,
  resolveHermesModelTier,
} from "./hermes-model-tiers.js";

describe("HERMES_MODEL_TIERS", () => {
  it("ships the Alibaba Token Plan pair the founder decided on", () => {
    expect(HERMES_MODEL_TIERS.high).toMatchObject({
      provider: "alibaba-token-plan-cn",
      model: "qwen3.8-max-0902",
      displayName: "Qwen 3.8 Max",
    });
    expect(HERMES_MODEL_TIERS.low).toMatchObject({
      provider: "alibaba-token-plan-cn",
      model: "deepseek-v4-flash",
      displayName: "DeepSeek V4.1 Flash",
    });
    // People-facing labels: "high tier" and "ops tier", never "low tier".
    expect(HERMES_MODEL_TIERS.low.tierLabel).toBe("ops tier");
  });
});

describe("modelTierForRole", () => {
  it("maps the two enum-only leadership roles to high", () => {
    // Review-1028 (item 4): the role enum alone decides ONLY for ceo and
    // chief_of_staff — a hire filed as either is leadership by definition.
    for (const role of ["chief_of_staff", "ceo"]) {
      expect(modelTierForRole(role), role).toBe("high");
    }
  });

  it("maps pm/cto to high when no title is present — the enum itself is leadership", () => {
    // A person explicitly choosing role=cto hires the C-suite role; the
    // title gate only kicks in when a title exists to contradict it.
    expect(modelTierForRole("pm")).toBe("high");
    expect(modelTierForRole("cto")).toBe("high");
  });

  it("maps pm/cto with a leadership title to high", () => {
    for (const title of ["Product Manager", "Head of Product", "VP Product", "CPO"]) {
      expect(modelTierForRole("pm", title), `pm / ${title}`).toBe("high");
    }
    for (const title of ["CTO", "Lead Engineer", "Engineering Lead", "Head of Engineering", "VP Engineering"]) {
      expect(modelTierForRole("cto", title), `cto / ${title}`).toBe("high");
    }
  });

  it("maps lead-engineering title variants to high even when the role enum does not", () => {
    for (const title of [
      "Lead Engineer",
      "Engineering Lead",
      "Head of Engineering",
      "Engineering Manager",
      "VP of Engineering",
      "Director of Engineering",
      "Technical Lead",
      "Chief of Staff",
      "Chief Executive Officer",
      "Product Manager",
    ]) {
      expect(modelTierForRole("general", title), title).toBe("high");
    }
  });

  it("maps every other role to low", () => {
    for (const role of ["general", "engineer", "designer", "marketer", "reviewer", "evaluator", null, undefined]) {
      expect(modelTierForRole(role), String(role)).toBe("low");
    }
    expect(modelTierForRole("engineer", "Backend Engineer")).toBe("low");
    expect(modelTierForRole("general", "Support Specialist")).toBe("low");
  });

  it("maps pm/cto with a NON-leadership title to low — review-1028 false positives", () => {
    // The whole point of the title gate: these all park in the pm/cto enum
    // via broad keywords but are execution, not leadership.
    for (const title of [
      "Project Coordinator",
      "Project Manager",
      "Program Manager",
      "Event Planner",
      "Scrum Master",
    ]) {
      expect(modelTierForRole("pm", title), `pm / ${title}`).toBe("low");
    }
    for (const title of ["Solutions Architect", "Data Architect"]) {
      expect(modelTierForRole("cto", title), `cto / ${title}`).toBe("low");
    }
  });

  it("rejects the review-1028 lookalike titles on any role", () => {
    for (const title of [
      "Executive Assistant to the CEO",
      "CEO Office Coordinator",
      "Head of Product Marketing",
      "Sales Engineering Lead",
      "Customer Success Engineering Manager",
    ]) {
      for (const role of ["general", "pm", "cto", "engineer"]) {
        expect(modelTierForRole(role, title), `${role} / ${title}`).toBe("low");
      }
    }
  });

  it("reads titles written as role slugs too", () => {
    expect(modelTierForRole("general", "lead_engineer")).toBe("high");
    expect(modelTierForRole(null, "head-of-engineering")).toBe("high");
  });
});

describe("resolveHermesModelTier", () => {
  it("returns the shipped spec without overrides", () => {
    expect(resolveHermesModelTier("high", {})).toMatchObject({
      provider: "alibaba-token-plan-cn",
      model: "qwen3.8-max-0902",
      displayName: "Qwen 3.8 Max",
    });
  });

  it("honours the instance env overrides", () => {
    const env = {
      AGENTDASH_HERMES_HIGH_MODEL: "qwen3.9-max-1001",
      AGENTDASH_HERMES_HIGH_PROVIDER: "alibaba-custom",
      AGENTDASH_HERMES_LOW_MODEL: "deepseek-v5-flash",
      AGENTDASH_HERMES_LOW_PROVIDER: "alibaba-custom",
    };
    expect(resolveHermesModelTier("high", env)).toMatchObject({
      model: "qwen3.9-max-1001",
      provider: "alibaba-custom",
    });
    expect(resolveHermesModelTier("low", env)).toMatchObject({
      model: "deepseek-v5-flash",
      provider: "alibaba-custom",
    });
  });

  it("drops a false display name when the model is overridden", () => {
    const spec = resolveHermesModelTier("high", { AGENTDASH_HERMES_HIGH_MODEL: "qwen-next" });
    expect(spec.displayName).toBe("qwen-next");
    expect(spec.tierLabel).toBe("high tier");
  });

  it("treats blank overrides as unset", () => {
    const spec = resolveHermesModelTier("low", { AGENTDASH_HERMES_LOW_MODEL: "   " });
    expect(spec.model).toBe(HERMES_MODEL_TIERS.low.model);
  });
});

describe("applyHermesModelTierDefault", () => {
  it("stamps the high tier on a modelless hermes_local leadership agent", () => {
    const result = applyHermesModelTierDefault({
      adapterType: HERMES_LOCAL_ADAPTER_TYPE,
      adapterConfig: {},
      role: "chief_of_staff",
      title: "Chief of Staff",
    });
    expect(result.appliedTier).toBe("high");
    expect(result.adapterConfig.model).toBe("qwen3.8-max-0902");
    expect(result.adapterConfig.provider).toBe("alibaba-token-plan-cn");
  });

  it("stamps the low tier on a modelless hermes_local ops agent", () => {
    const result = applyHermesModelTierDefault({
      adapterType: HERMES_LOCAL_ADAPTER_TYPE,
      adapterConfig: {},
      role: "engineer",
      title: "Backend Engineer",
    });
    expect(result.appliedTier).toBe("low");
    expect(result.adapterConfig.model).toBe("deepseek-v4-flash");
  });

  it("uses the title when the role enum is stripped to general", () => {
    const result = applyHermesModelTierDefault({
      adapterType: HERMES_LOCAL_ADAPTER_TYPE,
      adapterConfig: {},
      role: "general",
      title: "Head of Engineering",
    });
    expect(result.appliedTier).toBe("high");
  });

  it("never overwrites an explicit model — a human choice always wins", () => {
    const result = applyHermesModelTierDefault({
      adapterType: HERMES_LOCAL_ADAPTER_TYPE,
      adapterConfig: { model: "glm-5.3-flash", provider: "zai" },
      role: "ceo",
    });
    expect(result.appliedTier).toBeNull();
    expect(result.adapterConfig).toEqual({ model: "glm-5.3-flash", provider: "zai" });
  });

  it("keeps an explicit NON-tier provider whole — model and all (review-1028, item 3)", () => {
    // A provider a person set that is not the tier's is an explicit choice;
    // pairing a tier model with someone else's provider would silently
    // re-route the billing, so nothing is filled.
    const result = applyHermesModelTierDefault({
      adapterType: HERMES_LOCAL_ADAPTER_TYPE,
      adapterConfig: { provider: "zai" },
      role: "ceo",
    });
    expect(result.appliedTier).toBeNull();
    expect(result.adapterConfig).toEqual({ provider: "zai" });
  });

  it("still fills the model when the explicit provider IS the tier's", () => {
    const result = applyHermesModelTierDefault({
      adapterType: HERMES_LOCAL_ADAPTER_TYPE,
      adapterConfig: { provider: "alibaba-token-plan-cn" },
      role: "engineer",
    });
    expect(result.appliedTier).toBe("low");
    expect(result.adapterConfig).toEqual({
      provider: "alibaba-token-plan-cn",
      model: "deepseek-v4-flash",
    });
  });

  it("is a no-op for non-hermes adapters and never mutates the input", () => {
    const input = { command: "claude" };
    const result = applyHermesModelTierDefault({
      adapterType: "claude_local",
      adapterConfig: input,
      role: "ceo",
    });
    expect(result.appliedTier).toBeNull();
    expect(input).toEqual({ command: "claude" });
  });
});

describe("display helpers", () => {
  it("names shipped models in plain words", () => {
    expect(hermesModelDisplayName("qwen3.8-max-0902")).toBe("Qwen 3.8 Max");
    expect(hermesModelDisplayName("deepseek-v4-flash")).toBe("DeepSeek V4.1 Flash");
    expect(hermesModelDisplayName("glm-5.3-flash")).toBeNull();
  });

  it("labels tiers in plain words", () => {
    expect(hermesModelTierLabel("high")).toBe("high tier");
    expect(hermesModelTierLabel("low")).toBe("ops tier");
    expect(hermesModelTierLabel("custom")).toBeNull();
  });

  it("finds the tier a model belongs to, env-aware", () => {
    expect(hermesModelTierForModel("qwen3.8-max-0902", {})).toBe("high");
    expect(hermesModelTierForModel("deepseek-v4-flash", {})).toBe("low");
    expect(hermesModelTierForModel("glm-5.3-flash", {})).toBeNull();
    expect(
      hermesModelTierForModel("qwen-next", { AGENTDASH_HERMES_HIGH_MODEL: "qwen-next" }),
    ).toBe("high");
  });

  it("describes a tiered model the way the UI prints it", () => {
    expect(
      describeHermesModel({ model: "qwen3.8-max-0902", modelTier: "high" }),
    ).toMatchObject({ text: "Qwen 3.8 Max · high tier", rawTitle: "qwen3.8-max-0902" });
    expect(
      describeHermesModel({ model: "deepseek-v4-flash", modelTier: "low" }),
    ).toMatchObject({ text: "DeepSeek V4.1 Flash · ops tier" });
  });

  it("infers the tier for an agent whose metadata predates the stamp", () => {
    expect(describeHermesModel({ model: "qwen3.8-max-0902" })).toMatchObject({
      text: "Qwen 3.8 Max · high tier",
    });
  });

  it("shows a custom model as its raw id with no false tier", () => {
    expect(describeHermesModel({ model: "glm-5.3-flash" })).toMatchObject({
      text: "glm-5.3-flash",
    });
    expect(describeHermesModel({ model: "glm-5.3-flash", modelTier: "custom" })).toMatchObject({
      text: "glm-5.3-flash",
    });
    expect(describeHermesModel({ model: null })).toBeNull();
  });
});

describe("AGENT_MODEL_TIER_METADATA_KEY", () => {
  it("is the metadata field the UI and doctor command share", () => {
    expect(AGENT_MODEL_TIER_METADATA_KEY).toBe("modelTier");
  });
});

describe("hermesModelTiersEnabled (review-1028, item 1)", () => {
  it("is OFF by default — unset means the pre-tier behaviour", () => {
    expect(hermesModelTiersEnabled({})).toBe(false);
    expect(hermesModelTiersEnabled({ AGENTDASH_HERMES_MODEL_TIERS: "off" })).toBe(false);
    expect(hermesModelTiersEnabled({ AGENTDASH_HERMES_MODEL_TIERS: "yes" })).toBe(false);
    expect(hermesModelTiersEnabled({ AGENTDASH_HERMES_MODEL_TIERS: "1" })).toBe(false);
  });

  it("is ON only for exactly `on` (case/space-insensitive)", () => {
    expect(hermesModelTiersEnabled({ AGENTDASH_HERMES_MODEL_TIERS: "on" })).toBe(true);
    expect(hermesModelTiersEnabled({ AGENTDASH_HERMES_MODEL_TIERS: " ON " })).toBe(true);
  });
});

describe("hermesTierOverrideWarnings (review-1028, item 10)", () => {
  it("is silent when nothing is overridden and when pairs are complete", () => {
    expect(hermesTierOverrideWarnings({})).toEqual([]);
    expect(
      hermesTierOverrideWarnings({
        AGENTDASH_HERMES_HIGH_MODEL: "m",
        AGENTDASH_HERMES_HIGH_PROVIDER: "p",
      }),
    ).toEqual([]);
  });

  it("warns on an unpaired *_MODEL override — the Alibaba provider still applies", () => {
    const warnings = hermesTierOverrideWarnings({ AGENTDASH_HERMES_HIGH_MODEL: "qwen-next" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("AGENTDASH_HERMES_HIGH_MODEL");
    expect(warnings[0]).toContain("alibaba-token-plan-cn");
  });

  it("warns on an unpaired *_PROVIDER override — the shipped model still applies", () => {
    const warnings = hermesTierOverrideWarnings({ AGENTDASH_HERMES_LOW_PROVIDER: "other" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("AGENTDASH_HERMES_LOW_PROVIDER");
  });
});

describe("describeHermesModel provider/model label (review-1028, item 7)", () => {
  it("shows a non-tier model as raw provider/model when a provider is known", () => {
    expect(describeHermesModel({ model: "glm-5.3-flash", provider: "zai" })).toMatchObject({
      text: "zai/glm-5.3-flash",
      rawTitle: "zai/glm-5.3-flash",
    });
  });

  it("keeps the raw id alone when no provider is known", () => {
    expect(describeHermesModel({ model: "glm-5.3-flash" })).toMatchObject({
      text: "glm-5.3-flash",
    });
  });
});
