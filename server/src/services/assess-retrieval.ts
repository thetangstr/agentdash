/**
 * RAG retrieval for Agent Readiness Assessment.
 */
import {
  getAllMatrixCells,
  getMatrixCell,
  getAllMarkets,
  getAllCompanies,
  type MatrixCell,
  type VerticalMarket,
  type CompanyPlatform,
} from "./assess-data.js";

export interface AssessmentInput {
  companyName: string;
  industry: string;
  industrySlug: string;
  employeeRange: string;
  revenueRange: string;
  description: string;
  currentSystems: string;
  automationLevel: string;
  challenges: string;
  selectedFunctions: string[];
  primaryGoal: string;
  targets: string;
  timeline: string;
  budgetRange: string;
  aiUsageLevel: string;
  aiGovernance: string;
  agentExperience: string;
  aiOwnership: string;
}

export interface RetrievedContext {
  matrixCells: MatrixCell[];
  deepPlaybooks: MatrixCell[];
  marketReport: VerticalMarket | null;
  topPlatforms: Pick<CompanyPlatform, "name" | "slug" | "oneLiner" | "scores" | "capabilities">[];
}

const RELATED_INDUSTRIES: Record<string, string[]> = {
  construction: ["real-estate", "manufacturing"],
  "real-estate": ["construction"],
  healthcare: ["insurance"],
  insurance: ["healthcare", "financial-services"],
  "financial-services": ["insurance"],
  "e-commerce": ["retail"],
  retail: ["e-commerce"],
  "tech-saas": ["media-entertainment"],
  "energy-utilities": ["manufacturing"],
  logistics: ["manufacturing", "retail"],
  manufacturing: ["construction", "logistics"],
};

const FUNCTION_CATEGORY_SLUGS: Record<string, string[]> = {
  sales: ["business-development", "account-management", "revenue-operations"],
  "customer-support": ["contact-center", "field-service", "customer-success"],
  hr: ["talent-acquisition", "workforce-management", "hr-compliance"],
  finance: ["accounting-arap", "fpa-reporting", "risk-compliance", "procurement"],
  "it-engineering": ["cybersecurity", "devops-sre", "data-engineering", "software-dev"],
  operations: ["supply-chain", "facilities", "quality-regulatory", "program-management"],
};

export function expandSelectedFunctionSlugs(selectedFunctions: string[]): string[] {
  const expanded = new Set<string>();
  for (const slug of selectedFunctions) {
    const children = FUNCTION_CATEGORY_SLUGS[slug];
    if (children) {
      for (const child of children) expanded.add(child);
    } else {
      expanded.add(slug);
    }
  }
  return [...expanded];
}

export function retrieveContext(input: AssessmentInput): RetrievedContext {
  const allCells = getAllMatrixCells();
  const industryCells = allCells.filter((c) => c.industrySlug === input.industrySlug);
  const selectedFunctionSlugs = expandSelectedFunctionSlugs(input.selectedFunctions);

  const relevantCells =
    selectedFunctionSlugs.length > 0
      ? industryCells.filter((c) => selectedFunctionSlugs.includes(c.functionSlug))
      : industryCells;

  relevantCells.sort((a, b) => b.disruptionScore - a.disruptionScore);

  const deepPlaybooks: MatrixCell[] = [];
  for (const cell of relevantCells) {
    const full = getMatrixCell(cell.industrySlug, cell.functionSlug);
    if (full?.tier === "deep" && full.playbook) deepPlaybooks.push(full);
  }

  for (const relSlug of RELATED_INDUSTRIES[input.industrySlug] ?? []) {
    for (const fn of selectedFunctionSlugs) {
      const cell = getMatrixCell(relSlug, fn);
      if (cell?.tier === "deep" && cell.playbook) deepPlaybooks.push(cell);
    }
  }

  const markets = getAllMarkets();
  const marketReport =
    markets.find((m) => m.slug === input.industrySlug) ?? null;

  const companies = getAllCompanies();
  const topPlatforms = [...companies]
    .sort((a, b) => b.scores.total - a.scores.total)
    .slice(0, 8)
    .map((c) => ({ name: c.name, slug: c.slug, oneLiner: c.oneLiner, scores: c.scores, capabilities: c.capabilities }));

  return { matrixCells: relevantCells, deepPlaybooks, marketReport, topPlatforms };
}
