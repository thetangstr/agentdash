import { describe, it, expect } from "vitest";
import { resolveModelTier, checkMaxToolCalls, checkVerification } from "../services/model-router.js";

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

describe("checkMaxToolCalls", () => {
  it("passes when maxToolCalls is null", () => {
    expect(checkMaxToolCalls(10, null)).toEqual({ passed: true });
  });

  it("passes when tool calls are within limit", () => {
    expect(checkMaxToolCalls(2, 3)).toEqual({ passed: true });
  });

  it("passes when tool calls equal limit", () => {
    expect(checkMaxToolCalls(3, 3)).toEqual({ passed: true });
  });

  it("fails when tool calls exceed limit", () => {
    const result = checkMaxToolCalls(5, 3);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("exceeded_max_tool_calls");
    expect(result.reason).toContain("5 > 3");
  });
});

describe("checkVerification", () => {
  it("passes when verification is null", () => {
    expect(checkVerification({}, null)).toEqual({ passed: true });
  });

  it("passes when verification type is none", () => {
    expect(checkVerification({}, { type: "none" })).toEqual({ passed: true });
  });

  it("passes schema verification when all keys present", () => {
    const result = checkVerification(
      { message: "hello", category: "greeting" },
      { type: "schema", zodSchema: JSON.stringify({ message: "string", category: "string" }) },
    );
    expect(result).toEqual({ passed: true });
  });

  it("fails schema verification when keys are missing", () => {
    const result = checkVerification(
      { message: "hello" },
      { type: "schema", zodSchema: JSON.stringify({ message: "string", category: "string" }) },
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("schema_mismatch");
    expect(result.reason).toContain("category");
  });

  it("fails on invalid zodSchema JSON", () => {
    const result = checkVerification(
      { message: "hello" },
      { type: "schema", zodSchema: "not-valid-json" },
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toBe("schema_parse_error");
  });

  it("passes effect verification (no-op)", () => {
    expect(checkVerification({}, { type: "effect", command: "exit 0" })).toEqual({ passed: true });
  });
});
