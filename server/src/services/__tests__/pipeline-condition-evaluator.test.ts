import { describe, it, expect } from "vitest";
import { evaluateCondition } from "../pipeline-condition-evaluator.js";

describe("evaluateCondition", () => {
  const sampleData = {
    score: 0.85,
    status: "approved",
    count: 3,
    nested: { value: 42 },
    label: "high",
  };

  it("returns true for simple numeric comparison", () => {
    expect(evaluateCondition("data.score > 0.7", sampleData)).toBe(true);
  });

  it("returns false when numeric comparison fails", () => {
    expect(evaluateCondition("data.score > 0.9", sampleData)).toBe(false);
  });

  it("evaluates string equality", () => {
    expect(evaluateCondition('data.status === "approved"', sampleData)).toBe(true);
  });

  it("evaluates string inequality", () => {
    expect(evaluateCondition('data.status !== "rejected"', sampleData)).toBe(true);
  });

  it("evaluates nested property access", () => {
    expect(evaluateCondition("data.nested.value >= 42", sampleData)).toBe(true);
  });

  it("returns true for null/undefined condition (unconditional edge)", () => {
    expect(evaluateCondition(undefined, sampleData)).toBe(true);
    expect(evaluateCondition(null as unknown as string, sampleData)).toBe(true);
    expect(evaluateCondition("", sampleData)).toBe(true);
  });

  it("returns false for missing property", () => {
    expect(evaluateCondition("data.nonexistent > 0", sampleData)).toBe(false);
  });

  it("rejects dangerous expressions", () => {
    expect(() => evaluateCondition("process.exit(1)", sampleData)).toThrow();
    expect(() => evaluateCondition("require('fs')", sampleData)).toThrow();
    expect(() => evaluateCondition("eval('1+1')", sampleData)).toThrow();
    expect(() => evaluateCondition("data.__proto__", sampleData)).toThrow();
  });

  it("supports boolean operators", () => {
    expect(evaluateCondition("data.score > 0.5 && data.count > 2", sampleData)).toBe(true);
    expect(evaluateCondition("data.score < 0.5 || data.count > 2", sampleData)).toBe(true);
  });

  it("supports equality with numbers", () => {
    expect(evaluateCondition("data.count === 3", sampleData)).toBe(true);
  });
});
