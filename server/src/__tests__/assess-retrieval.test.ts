import { describe, it, expect } from "vitest";
import { retrieveContext, type AssessmentInput } from "../services/assess-retrieval.js";

function makeInput(overrides?: Partial<AssessmentInput>): AssessmentInput {
  return {
    companyName: "Test Corp",
    industry: "Healthcare",
    industrySlug: "healthcare",
    employeeRange: "201-1000",
    revenueRange: "$50M-$200M",
    description: "A healthcare company",
    currentSystems: "Epic, Salesforce",
    automationLevel: "basic",
    challenges: "Manual processes",
    selectedFunctions: [],
    primaryGoal: "Both",
    targets: "",
    timeline: "3-6 months",
    budgetRange: "$100K-$250K",
    aiUsageLevel: "Individual tools",
    aiGovernance: "None",
    agentExperience: "Never tried",
    aiOwnership: "Nobody",
    ...overrides,
  };
}

describe("assess-retrieval", () => {
  it("returns matrix cells for a known industry", () => {
    const ctx = retrieveContext(makeInput({ industrySlug: "healthcare" }));
    expect(ctx.matrixCells.length).toBeGreaterThan(0);
    expect(ctx.matrixCells.every((c) => c.industrySlug === "healthcare")).toBe(true);
  });

  it("returns empty cells for unknown industry", () => {
    const ctx = retrieveContext(makeInput({ industrySlug: "underwater-basket-weaving" }));
    expect(ctx.matrixCells).toEqual([]);
  });

  it("filters by selected functions when provided", () => {
    const ctx = retrieveContext(
      makeInput({ industrySlug: "healthcare", selectedFunctions: ["cybersecurity"] }),
    );
    expect(ctx.matrixCells.length).toBeGreaterThan(0);
    expect(ctx.matrixCells.every((c) => c.functionSlug === "cybersecurity")).toBe(true);
  });

  it("sorts cells by disruption score descending", () => {
    const ctx = retrieveContext(makeInput({ industrySlug: "e-commerce" }));
    for (let i = 1; i < ctx.matrixCells.length; i++) {
      expect(ctx.matrixCells[i - 1].disruptionScore).toBeGreaterThanOrEqual(
        ctx.matrixCells[i].disruptionScore,
      );
    }
  });

  it("includes deep playbooks when available", () => {
    const ctx = retrieveContext(
      makeInput({ industrySlug: "healthcare", selectedFunctions: ["cybersecurity"] }),
    );
    expect(ctx.deepPlaybooks.length).toBeGreaterThan(0);
    expect(ctx.deepPlaybooks[0].tier).toBe("deep");
  });

  it("looks up related industries for deep playbooks", () => {
    const ctx = retrieveContext(
      makeInput({ industrySlug: "healthcare", selectedFunctions: ["cybersecurity"] }),
    );
    const relatedPlaybooks = ctx.deepPlaybooks.filter(
      (p) => p.industrySlug !== "healthcare",
    );
    expect(Array.isArray(relatedPlaybooks)).toBe(true);
  });

  it("returns top competitor platforms", () => {
    const ctx = retrieveContext(makeInput());
    expect(ctx.topPlatforms.length).toBeGreaterThan(0);
    expect(ctx.topPlatforms.length).toBeLessThanOrEqual(8);
    expect(ctx.topPlatforms[0]).toHaveProperty("name");
    expect(ctx.topPlatforms[0]).toHaveProperty("scores");
  });

  it("returns market report when available", () => {
    const ctx = retrieveContext(makeInput({ industrySlug: "healthcare" }));
    expect(ctx.marketReport).not.toBeNull();
    expect(ctx.marketReport?.sector).toBeTruthy();
  });

  it("returns null market report for unknown industry", () => {
    const ctx = retrieveContext(makeInput({ industrySlug: "underwater-basket-weaving" }));
    expect(ctx.marketReport).toBeNull();
  });
});
