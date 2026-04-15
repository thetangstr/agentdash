/**
 * Shared test data builders.
 * Usage: buildCompany({ name: "Custom" }) — returns full object with defaults.
 */
import { randomUUID } from "node:crypto";

export function buildCompany(overrides?: Record<string, unknown>) {
  return {
    id: randomUUID(),
    name: "Test Corp",
    issuePrefix: "TC",
    description: "A test company",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function buildAgent(overrides?: Record<string, unknown>) {
  return {
    id: randomUUID(),
    companyId: "company-1",
    name: "Test Agent",
    role: "engineer",
    status: "idle",
    model: "claude-sonnet-4-20250514",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function buildIssue(overrides?: Record<string, unknown>) {
  return {
    id: randomUUID(),
    companyId: "company-1",
    title: "Test Issue",
    description: "A test issue",
    status: "open",
    priority: "medium",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function buildAssessmentInput(overrides?: Record<string, unknown>) {
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
    selectedFunctions: [] as string[],
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
