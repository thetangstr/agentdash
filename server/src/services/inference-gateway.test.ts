import { describe, expect, it } from "vitest";
import {
  DEFAULT_GATEWAY_MODEL_ID,
  GATEWAY_MODELS,
  GatewayConfigError,
  computeGatewayCostUsd,
  findGatewayModel,
  isGatewayConfigured,
  listGatewayModels,
  recordGatewayUsage,
  resolveGatewayAccess,
} from "./inference-gateway.js";

const ENV = {
  AGENTDASH_GATEWAY_BASE_URL: "https://gw.example/api/v1",
  AGENTDASH_GATEWAY_API_KEY: "sk-platform",
} as NodeJS.ProcessEnv;

describe("inference-gateway model table", () => {
  it("default model id points at a real entry", () => {
    expect(findGatewayModel(DEFAULT_GATEWAY_MODEL_ID)).toBeDefined();
  });

  it("findGatewayModel matches by canonical id and by provider model", () => {
    const entry = GATEWAY_MODELS[0]!;
    expect(findGatewayModel(entry.id)?.id).toBe(entry.id);
    expect(findGatewayModel(entry.providerModel)?.id).toBe(entry.id);
    expect(findGatewayModel("nope")).toBeUndefined();
    expect(findGatewayModel(null)).toBeUndefined();
  });

  it("listGatewayModels returns {id,label} for every entry", () => {
    const models = listGatewayModels();
    expect(models).toHaveLength(GATEWAY_MODELS.length);
    expect(models.every((m) => m.id && m.label)).toBe(true);
  });
});

describe("isGatewayConfigured", () => {
  it("true only when base url AND key are present", () => {
    expect(isGatewayConfigured(ENV)).toBe(true);
    expect(isGatewayConfigured({ AGENTDASH_GATEWAY_BASE_URL: "x" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isGatewayConfigured({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("resolveGatewayAccess", () => {
  it("resolves platform env + default model", () => {
    const access = resolveGatewayAccess({ companyId: "c1", env: ENV });
    expect(access.baseUrl).toBe("https://gw.example/api/v1");
    expect(access.apiKey).toBe("sk-platform");
    expect(access.protocol).toBe("openai");
    expect(access.canonicalModel).toBe(DEFAULT_GATEWAY_MODEL_ID);
    expect(access.model).toBe(findGatewayModel(DEFAULT_GATEWAY_MODEL_ID)!.providerModel);
  });

  it("honors a requested model", () => {
    const access = resolveGatewayAccess({ companyId: "c1", requestedModel: "gpt-4o-mini", env: ENV });
    expect(access.canonicalModel).toBe("gpt-4o-mini");
    expect(access.model).toBe("openai/gpt-4o-mini");
    expect(access.provider).toBe("openai");
  });

  it("falls back to the default model for an unknown request", () => {
    const access = resolveGatewayAccess({ companyId: "c1", requestedModel: "does-not-exist", env: ENV });
    expect(access.canonicalModel).toBe(DEFAULT_GATEWAY_MODEL_ID);
  });

  it("BYO override takes precedence over platform env", () => {
    const access = resolveGatewayAccess({
      companyId: "c1",
      override: { baseUrl: "https://onprem.local/v1", apiKey: "byo-key", protocol: "anthropic" },
      env: ENV,
    });
    expect(access.baseUrl).toBe("https://onprem.local/v1");
    expect(access.apiKey).toBe("byo-key");
    expect(access.protocol).toBe("anthropic");
  });

  it("reads protocol from env when set", () => {
    const access = resolveGatewayAccess({
      companyId: "c1",
      env: { ...ENV, AGENTDASH_GATEWAY_PROTOCOL: "anthropic" } as NodeJS.ProcessEnv,
    });
    expect(access.protocol).toBe("anthropic");
  });

  it("throws GatewayConfigError when base url missing", () => {
    expect(() => resolveGatewayAccess({ companyId: "c1", env: { AGENTDASH_GATEWAY_API_KEY: "k" } as NodeJS.ProcessEnv })).toThrow(
      GatewayConfigError,
    );
  });

  it("throws GatewayConfigError when api key missing", () => {
    expect(() =>
      resolveGatewayAccess({ companyId: "c1", env: { AGENTDASH_GATEWAY_BASE_URL: "u" } as NodeJS.ProcessEnv }),
    ).toThrow(GatewayConfigError);
  });
});

describe("computeGatewayCostUsd", () => {
  it("prices input + output + cached at table rates", () => {
    // claude-sonnet: in 3, out 15, cached 0.3 per 1M
    const cost = computeGatewayCostUsd("claude-sonnet", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(3 + 15 + 0.3, 6);
  });

  it("falls back to input rate when cached rate is unset", () => {
    // minimax-m2 has no cachedInputPer1M -> cached billed at input rate (0.3)
    const cost = computeGatewayCostUsd("minimax-m2", {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(0.3, 6);
  });

  it("returns 0 for unknown model", () => {
    expect(computeGatewayCostUsd("nope", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(0);
  });

  it("handles missing/negative token counts safely", () => {
    expect(computeGatewayCostUsd("gpt-4o-mini", { inputTokens: -5, outputTokens: 0 })).toBe(0);
  });
});

describe("recordGatewayUsage", () => {
  it("summarizes cost + provider + canonical model", () => {
    const r = recordGatewayUsage({
      canonicalModel: "gpt-4o-mini",
      usage: { inputTokens: 2_000_000, outputTokens: 0 },
    });
    expect(r.provider).toBe("openai");
    expect(r.canonicalModel).toBe("gpt-4o-mini");
    expect(r.costUsd).toBeCloseTo(0.3, 6); // 2M input * 0.15/1M
  });
});
