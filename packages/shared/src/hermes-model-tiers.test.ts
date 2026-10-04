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
  it("maps every leadership role enum to high", () => {
    for (const role of ["chief_of_staff", "ceo", "pm", "cto"]) {
      expect(modelTierForRole(role), role).toBe("high");
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

  it("keeps an explicit provider when only the model is defaulted", () => {
    const result = applyHermesModelTierDefault({
      adapterType: HERMES_LOCAL_ADAPTER_TYPE,
      adapterConfig: { provider: "openrouter" },
      role: "engineer",
    });
    expect(result.appliedTier).toBe("low");
    expect(result.adapterConfig.provider).toBe("openrouter");
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
