import { describe, it, expect } from "vitest";
import { resolveModelTier } from "../services/model-router.js";

describe("resolveModelTier", () => {
  const baseAgent = {
    adapterType: "claude_local",
    adapterConfig: { model: "opus" },
  };

  it("returns agent default when no skill and no pipeline stage", () => {
    const result = resolveModelTier({
      agent: baseAgent,
      skill: null,
      pipelineStage: null,
    });
    expect(result).toEqual({ model: "opus", tier: "default" });
  });

  it("returns agent default when skill has no modelTier", () => {
    const result = resolveModelTier({
      agent: baseAgent,
      skill: { modelTier: null, maxToolCalls: null, verification: null },
      pipelineStage: null,
    });
    expect(result).toEqual({ model: "opus", tier: "default" });
  });

  it("returns small model when skill has modelTier small", () => {
    const result = resolveModelTier({
      agent: baseAgent,
      skill: { modelTier: "small", maxToolCalls: 3, verification: null },
      pipelineStage: null,
    });
    expect(result).toEqual({ model: "haiku", tier: "small" });
  });

  it("pipeline stage modelTier overrides skill modelTier", () => {
    const result = resolveModelTier({
      agent: baseAgent,
      skill: { modelTier: null, maxToolCalls: null, verification: null },
      pipelineStage: { modelTier: "small" },
    });
    expect(result).toEqual({ model: "haiku", tier: "small" });
  });

  it("pipeline stage null does not override skill small", () => {
    const result = resolveModelTier({
      agent: baseAgent,
      skill: { modelTier: "small", maxToolCalls: 2, verification: null },
      pipelineStage: { modelTier: null },
    });
    expect(result).toEqual({ model: "haiku", tier: "small" });
  });

  it("maps small model per adapter type", () => {
    const geminiAgent = {
      adapterType: "gemini_local",
      adapterConfig: { model: "gemini-pro" },
    };
    const result = resolveModelTier({
      agent: geminiAgent,
      skill: { modelTier: "small", maxToolCalls: 1, verification: null },
      pipelineStage: null,
    });
    expect(result).toEqual({ model: "gemini-flash", tier: "small" });
  });

  it("falls back to agent default if adapter type has no small model mapping", () => {
    const unknownAgent = {
      adapterType: "custom_adapter",
      adapterConfig: { model: "custom-model" },
    };
    const result = resolveModelTier({
      agent: unknownAgent,
      skill: { modelTier: "small", maxToolCalls: 1, verification: null },
      pipelineStage: null,
    });
    expect(result).toEqual({ model: "custom-model", tier: "default" });
  });
});
