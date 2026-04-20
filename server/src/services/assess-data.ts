/**
 * Static data loader for Agent Readiness Assessment.
 * Reads JSON files from server/src/data/ at runtime.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../data");

// ── Types (inline — only used server-side) ──────────────────────────────────

export interface MatrixWorkflow {
  name: string;
  description: string;
  currentPain: string;
  agentPotential: "high" | "medium" | "low";
}

export interface MatrixPlaybook {
  marketSizing?: { tam: string; sam: string; som: string };
  currentState?: string;
  idealCustomerProfile?: {
    segment: string;
    size: string;
    painIntensity: string;
    buyerTitle: string;
    budget: string;
  };
  entryWedge?: {
    workflow: string;
    why: string;
    proofOfConcept: string;
    timeToValue: string;
  };
  successMetrics?: Array<{
    metric: string;
    baseline: string;
    target: string;
    timeframe: string;
  }>;
  competitiveLandscape?: string;
  pricingModel?: string;
  riskAssessment?: Array<{ risk: string; severity: string; mitigation: string }>;
  deploymentTimeline?: Array<{ phase: string; duration: string; milestone: string }>;
}

export interface MatrixCell {
  industry: string;
  industrySlug: string;
  jobFunction: string;
  functionSlug: string;
  disruptionScore: number;
  summary: string;
  workflows?: MatrixWorkflow[];
  pactAssessment?: string;
  wactScores?: { W: number; A: number; C: number; T: number };
  tier?: "light" | "deep";
  playbook?: MatrixPlaybook;
}

export interface VerticalMarket {
  slug: string;
  sector: string;
  narrative: string;
  buyerPromise: string;
  pactScore: {
    total: number;
    dimensions: Array<{ key: string; score: number }>;
  };
  examples?: Array<{
    name: string;
    challenge: string;
    humanHoursAndDollarImpact: string;
  }>;
  quickStart?: string[];
  avoid?: string[];
}

export interface CompanyPlatform {
  name: string;
  slug: string;
  oneLiner: string;
  scores: { total: number; [k: string]: number };
  capabilities: string[];
}

// ── Loaders ─────────────────────────────────────────────────────────────────

function loadJsonDir<T>(subdir: string): T[] {
  const dir = path.join(DATA_DIR, subdir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as T);
}

// ── WACT score computation ──────────────────────────────────────────────────

const INDUSTRY_PROFILES: Record<string, { W: number; A: number; C: number; T: number }> = {
  "public-sector":       { W: 3, A: 2, C: 3, T: 2 },
  "e-commerce":          { W: 4, A: 4, C: 4, T: 4 },
  "insurance":           { W: 3, A: 3, C: 3, T: 2 },
  "healthcare":          { W: 3, A: 2, C: 4, T: 1 },
  "logistics":           { W: 4, A: 3, C: 3, T: 3 },
  "financial-services":  { W: 3, A: 3, C: 3, T: 2 },
  "manufacturing":       { W: 4, A: 3, C: 3, T: 3 },
  "real-estate":         { W: 3, A: 3, C: 3, T: 4 },
  "legal":               { W: 2, A: 3, C: 2, T: 2 },
  "education":           { W: 3, A: 3, C: 4, T: 4 },
  "tech-saas":           { W: 4, A: 5, C: 4, T: 4 },
  "retail":              { W: 4, A: 4, C: 4, T: 4 },
  "energy-utilities":    { W: 3, A: 2, C: 3, T: 2 },
  "telecom":             { W: 3, A: 3, C: 3, T: 3 },
  "media-entertainment": { W: 4, A: 4, C: 4, T: 4 },
  "construction":        { W: 3, A: 2, C: 3, T: 3 },
  "hospitality":         { W: 4, A: 3, C: 4, T: 4 },
  "agriculture":         { W: 3, A: 2, C: 3, T: 3 },
};

const FUNCTION_ADJUSTMENTS: Record<string, { W: number; A: number; C: number; T: number }> = {
  "contact-center":     { W: 1, A: 1, C: 0, T: 1 },
  "cybersecurity":      { W: 0, A: 0, C: 1, T: -1 },
  "risk-compliance":    { W: 0, A: 0, C: 0, T: -1 },
  "accounting-arap":    { W: 1, A: 0, C: 0, T: 0 },
  "talent-acquisition": { W: 1, A: 1, C: 0, T: 1 },
  "data-engineering":   { W: 0, A: 1, C: 1, T: 1 },
  "program-management": { W: 0, A: 0, C: 0, T: 1 },
  "quality-regulatory": { W: 0, A: -1, C: 0, T: -1 },
  "supply-chain":       { W: 0, A: 0, C: 0, T: 0 },
  "field-service":      { W: 0, A: -1, C: 0, T: 0 },
};

function computeWactScores(cell: MatrixCell): { W: number; A: number; C: number; T: number } {
  if (cell.wactScores) return cell.wactScores;
  const base = INDUSTRY_PROFILES[cell.industrySlug] ?? { W: 3, A: 3, C: 3, T: 3 };
  const adj = FUNCTION_ADJUSTMENTS[cell.functionSlug] ?? { W: 0, A: 0, C: 0, T: 0 };
  const dBoost = cell.disruptionScore >= 8 ? 1 : cell.disruptionScore >= 5 ? 0 : -1;
  const highPotentialCount = cell.workflows?.filter((w) => w.agentPotential === "high").length ?? 0;
  const wBoost = highPotentialCount >= 2 ? 1 : 0;
  const clamp = (n: number) => Math.max(1, Math.min(5, n));
  return {
    W: clamp(base.W + adj.W + dBoost + wBoost),
    A: clamp(base.A + adj.A + dBoost),
    C: clamp(base.C + adj.C + dBoost),
    T: clamp(base.T + adj.T),
  };
}

function enrichCell(cell: MatrixCell): MatrixCell {
  if (!cell.wactScores) cell.wactScores = computeWactScores(cell);
  return cell;
}

// ── Public API ──────────────────────────────────────────────────────────────

export function getAllMatrixCells(): MatrixCell[] {
  const indexPath = path.join(DATA_DIR, "matrix", "index.json");
  if (!fs.existsSync(indexPath)) return [];
  const cells = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as MatrixCell[];
  return cells.map(enrichCell);
}

export function getMatrixCell(industrySlug: string, functionSlug: string): MatrixCell | undefined {
  const deepPath = path.join(DATA_DIR, "matrix", "deep", `${industrySlug}-${functionSlug}.json`);
  if (fs.existsSync(deepPath)) {
    return enrichCell(JSON.parse(fs.readFileSync(deepPath, "utf-8")) as MatrixCell);
  }
  return getAllMatrixCells().find(
    (c) => c.industrySlug === industrySlug && c.functionSlug === functionSlug,
  );
}

export function getAllMarkets(): VerticalMarket[] {
  return loadJsonDir<VerticalMarket>("markets");
}

export function getAllCompanies(): CompanyPlatform[] {
  return loadJsonDir<CompanyPlatform>("companies");
}
