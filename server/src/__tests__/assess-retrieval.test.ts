import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { retrieveContext, type AssessmentInput } from "../services/assess-retrieval.js";

// Closes #286 (assess-retrieval portion): retrieveContext reads JSON
// fixtures from server/src/data/{matrix,markets,companies}/ — but that
// directory is NOT in the repo (it's an external asset bundle that's
// dropped in by a separate provisioning step, never committed). Tests
// that probe specific industries / playbooks / markets pass only when
// those fixtures exist on disk; in a fresh checkout they fail with
// empty-result assertions like "expected 0 to be greater than 0".
//
// Skip those tests when the data dir is empty. The two
// "returns null/empty for unknown industry" tests still run because
// they assert ABSENCE — they pass against an empty data dir too.
const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(here, "../data");
const hasMatrixData = fs.existsSync(path.join(DATA_DIR, "matrix", "index.json"));
const hasMarketsData = fs.existsSync(path.join(DATA_DIR, "markets"))
  && fs.readdirSync(path.join(DATA_DIR, "markets")).length > 0;
const hasCompaniesData = fs.existsSync(path.join(DATA_DIR, "companies"))
  && fs.readdirSync(path.join(DATA_DIR, "companies")).length > 0;

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
  it.skipIf(!hasMatrixData)("returns matrix cells for a known industry", () => {
    const ctx = retrieveContext(makeInput({ industrySlug: "healthcare" }));
    expect(ctx.matrixCells.length).toBeGreaterThan(0);
    expect(ctx.matrixCells.every((c) => c.industrySlug === "healthcare")).toBe(true);
  });

  it("returns empty cells for unknown industry", () => {
    const ctx = retrieveContext(makeInput({ industrySlug: "underwater-basket-weaving" }));
    expect(ctx.matrixCells).toEqual([]);
  });

  it.skipIf(!hasMatrixData)("filters by selected functions when provided", () => {
    const ctx = retrieveContext(
      makeInput({ industrySlug: "healthcare", selectedFunctions: ["cybersecurity"] }),
    );
    expect(ctx.matrixCells.length).toBeGreaterThan(0);
    expect(ctx.matrixCells.every((c) => c.functionSlug === "cybersecurity")).toBe(true);
  });

  it.skipIf(!hasMatrixData)("sorts cells by disruption score descending", () => {
    const ctx = retrieveContext(makeInput({ industrySlug: "e-commerce" }));
    for (let i = 1; i < ctx.matrixCells.length; i++) {
      expect(ctx.matrixCells[i - 1].disruptionScore).toBeGreaterThanOrEqual(
        ctx.matrixCells[i].disruptionScore,
      );
    }
  });

  it.skipIf(!hasMatrixData)("includes deep playbooks when available", () => {
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

  it.skipIf(!hasCompaniesData)("returns top competitor platforms", () => {
    const ctx = retrieveContext(makeInput());
    expect(ctx.topPlatforms.length).toBeGreaterThan(0);
    expect(ctx.topPlatforms.length).toBeLessThanOrEqual(8);
    expect(ctx.topPlatforms[0]).toHaveProperty("name");
    expect(ctx.topPlatforms[0]).toHaveProperty("scores");
  });

  it.skipIf(!hasMarketsData)("returns market report when available", () => {
    const ctx = retrieveContext(makeInput({ industrySlug: "healthcare" }));
    expect(ctx.marketReport).not.toBeNull();
    expect(ctx.marketReport?.sector).toBeTruthy();
  });

  it("returns null market report for unknown industry", () => {
    const ctx = retrieveContext(makeInput({ industrySlug: "underwater-basket-weaving" }));
    expect(ctx.marketReport).toBeNull();
  });
});
