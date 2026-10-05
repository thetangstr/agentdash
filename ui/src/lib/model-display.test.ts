import { describe, expect, it } from "vitest";
import { modelDisplayName } from "./model-display";

describe("modelDisplayName", () => {
  // AgentDash (c4-polish): the run header showed "Model: k3" — an opaque
  // provider alias that means nothing to an owner.
  it("maps provider aliases to readable names", () => {
    expect(modelDisplayName("k3")).toBe("Kimi K3");
    expect(modelDisplayName("kimi-k2.5")).toBe("Kimi K2.5");
    expect(modelDisplayName("qwen3.8-max-0902")).toBe("Qwen 3.8 Max");
    expect(modelDisplayName("deepseek-v4-flash")).toBe("DeepSeek V4.1 Flash");
  });

  it("maps the leaf of a provider/model id", () => {
    expect(modelDisplayName("kimi-coding/k3")).toBe("Kimi K3");
    expect(modelDisplayName("auto/k3")).toBe("Kimi K3");
  });

  it("leaves ids it does not know unchanged", () => {
    expect(modelDisplayName("anthropic/claude-opus-4-5")).toBe("anthropic/claude-opus-4-5");
    expect(modelDisplayName("glm-5")).toBe("glm-5");
  });

  it("returns null for empty input", () => {
    expect(modelDisplayName(null)).toBeNull();
    expect(modelDisplayName("")).toBeNull();
    expect(modelDisplayName("   ")).toBeNull();
  });
});
