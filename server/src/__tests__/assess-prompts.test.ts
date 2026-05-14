import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildUserPrompt, buildJumpstartPrompt, serializeContext } from "../services/assess-prompts.js";
import { retrieveContext, type AssessmentInput } from "../services/assess-retrieval.js";

// Closes #286 (assess-prompts portion): the "serializeContext includes
// matrix cells" assertion relies on the matrix data files at
// server/src/data/matrix/ (uncommitted asset bundle — see
// assess-retrieval.test.ts for the broader context). Skip when missing.
const here = path.dirname(fileURLToPath(import.meta.url));
const hasMatrixData = fs.existsSync(
  path.resolve(here, "../data/matrix/index.json"),
);

function makeInput(overrides?: Partial<AssessmentInput>): AssessmentInput {
  return {
    companyName: "Acme Health",
    industry: "Healthcare",
    industrySlug: "healthcare",
    employeeRange: "201-1000",
    revenueRange: "$50M-$200M",
    description: "Hospital management",
    currentSystems: "Epic, Salesforce",
    automationLevel: "basic",
    challenges: "Manual scheduling",
    selectedFunctions: [],
    primaryGoal: "Both",
    targets: "30% efficiency gain",
    timeline: "3-6 months",
    budgetRange: "$100K-$250K",
    aiUsageLevel: "Individual tools",
    aiGovernance: "None",
    agentExperience: "Never tried",
    aiOwnership: "Nobody",
    ...overrides,
  };
}

describe("assess-prompts", () => {
  it.skipIf(!hasMatrixData)("serializeContext includes matrix cells", () => {
    const input = makeInput();
    const ctx = retrieveContext(input);
    const text = serializeContext(ctx, input);
    expect(text).toContain("Healthcare");
    expect(text).toContain("opportunity");
  });

  it("buildSystemPrompt includes WACT framework and serialized data", () => {
    const input = makeInput();
    const ctx = retrieveContext(input);
    const serialized = serializeContext(ctx, input);
    const prompt = buildSystemPrompt(serialized);
    expect(prompt).toContain("WACT");
    expect(prompt).toContain("AgentDash");
    expect(prompt).toContain("RESEARCH DATA");
  });

  it("buildUserPrompt includes company profile fields", () => {
    const input = makeInput();
    const prompt = buildUserPrompt(input, "Some website content about hospitals");
    expect(prompt).toContain("Acme Health");
    expect(prompt).toContain("Healthcare");
    expect(prompt).toContain("Epic, Salesforce");
    expect(prompt).toContain("hospitals");
  });

  it("buildUserPrompt omits website section when no content", () => {
    const input = makeInput();
    const prompt = buildUserPrompt(input);
    expect(prompt).not.toContain("Company Website Research");
  });

  it("buildJumpstartPrompt includes assessment output and company name", () => {
    const input = makeInput();
    const prompt = buildJumpstartPrompt(input, "## Executive Summary\nGreat opportunities...");
    expect(prompt).toContain("Acme Health");
    expect(prompt).toContain("Executive Summary");
    expect(prompt).toContain("Jumpstart");
  });
});
