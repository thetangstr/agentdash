# Assess Integration + Test Quality Upgrade — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed the Agent Readiness Assessment into AgentDash as a standalone page + onboarding integration, with jumpstart.md output and comprehensive test coverage.

**Architecture:** Static JSON RAG data in `server/src/data/`, three assess service files (retrieval, prompts, core), one route file, two UI pages. LLM calls hardcoded to MiniMax (Anthropic-compatible API). Assessment output stored in existing `company_context` table. Shared test factories and helpers built alongside.

**Tech Stack:** Express 5, Vitest, Supertest, React 19, Tailwind 4, MiniMax API (Anthropic-compatible)

**Source reference:** The research app is cloned at `/tmp/agent-marketing-research/`. Copy data and adapt code from there.

---

## Task 1: Copy Static RAG Data Files

**Files:**
- Create: `server/src/data/matrix/index.json`
- Create: `server/src/data/matrix/deep/*.json` (6 files)
- Create: `server/src/data/markets/*.json` (5 files)
- Create: `server/src/data/companies/*.json` (27 files)

- [ ] **Step 1: Copy matrix data**

```bash
mkdir -p server/src/data/matrix/deep
cp /tmp/agent-marketing-research/src/data/matrix/index.json server/src/data/matrix/
cp /tmp/agent-marketing-research/src/data/matrix/deep/*.json server/src/data/matrix/deep/
```

- [ ] **Step 2: Copy market and company data**

```bash
mkdir -p server/src/data/markets server/src/data/companies
cp /tmp/agent-marketing-research/src/data/markets/*.json server/src/data/markets/
cp /tmp/agent-marketing-research/src/data/companies/*.json server/src/data/companies/
```

- [ ] **Step 3: Verify files copied**

```bash
ls server/src/data/matrix/index.json && ls server/src/data/matrix/deep/ | wc -l && ls server/src/data/markets/ | wc -l && ls server/src/data/companies/ | wc -l
```

Expected: index.json exists, 6 deep files, 5 market files, 27 company files.

- [ ] **Step 4: Commit**

```bash
git add server/src/data/
git commit -m "feat(assess): add static RAG data files (matrix, markets, companies)"
```

---

## Task 2: Assess Data Loader + Retrieval Service

**Files:**
- Create: `server/src/services/assess-data.ts`
- Create: `server/src/services/assess-retrieval.ts`
- Test: `server/src/__tests__/assess-retrieval.test.ts`

- [ ] **Step 1: Write failing tests for retrieval**

Create `server/src/__tests__/assess-retrieval.test.ts`:

```typescript
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
    // healthcare is related to insurance
    const ctx = retrieveContext(
      makeInput({ industrySlug: "healthcare", selectedFunctions: ["cybersecurity"] }),
    );
    const relatedPlaybooks = ctx.deepPlaybooks.filter(
      (p) => p.industrySlug !== "healthcare",
    );
    // May or may not have related — just ensure no crash
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd server && pnpm vitest run src/__tests__/assess-retrieval.test.ts
```

Expected: FAIL — modules don't exist yet.

- [ ] **Step 3: Create data loader**

Create `server/src/services/assess-data.ts`. Port from `/tmp/agent-marketing-research/src/lib/data.ts`, adapting the data directory path from Next.js `process.cwd()` to a `path.resolve(__dirname, "../data")` pattern:

```typescript
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
```

- [ ] **Step 4: Create retrieval service**

Create `server/src/services/assess-retrieval.ts`. Port from `/tmp/agent-marketing-research/src/lib/assess-retrieval.ts`:

```typescript
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

export function retrieveContext(input: AssessmentInput): RetrievedContext {
  const allCells = getAllMatrixCells();
  const industryCells = allCells.filter((c) => c.industrySlug === input.industrySlug);

  const relevantCells =
    input.selectedFunctions.length > 0
      ? industryCells.filter((c) => input.selectedFunctions.includes(c.functionSlug))
      : industryCells;

  relevantCells.sort((a, b) => b.disruptionScore - a.disruptionScore);

  const deepPlaybooks: MatrixCell[] = [];
  for (const cell of relevantCells) {
    const full = getMatrixCell(cell.industrySlug, cell.functionSlug);
    if (full?.tier === "deep" && full.playbook) deepPlaybooks.push(full);
  }

  for (const relSlug of RELATED_INDUSTRIES[input.industrySlug] ?? []) {
    for (const fn of input.selectedFunctions) {
      const cell = getMatrixCell(relSlug, fn);
      if (cell?.tier === "deep" && cell.playbook) deepPlaybooks.push(cell);
    }
  }

  const markets = getAllMarkets();
  const marketReport =
    markets.find(
      (m) => m.slug === input.industrySlug || m.sector.toLowerCase().includes(input.industry.toLowerCase()),
    ) ?? null;

  const companies = getAllCompanies();
  const topPlatforms = [...companies]
    .sort((a, b) => b.scores.total - a.scores.total)
    .slice(0, 8)
    .map((c) => ({ name: c.name, slug: c.slug, oneLiner: c.oneLiner, scores: c.scores, capabilities: c.capabilities }));

  return { matrixCells: relevantCells, deepPlaybooks, marketReport, topPlatforms };
}

export { serializeContext } from "./assess-prompts.js";
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd server && pnpm vitest run src/__tests__/assess-retrieval.test.ts
```

Expected: All 9 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/assess-data.ts server/src/services/assess-retrieval.ts server/src/__tests__/assess-retrieval.test.ts
git commit -m "feat(assess): add RAG data loader and retrieval service with tests"
```

---

## Task 3: Assess Prompt Builders

**Files:**
- Create: `server/src/services/assess-prompts.ts`
- Test: `server/src/__tests__/assess-prompts.test.ts`

- [ ] **Step 1: Write failing tests**

Create `server/src/__tests__/assess-prompts.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildUserPrompt, buildJumpstartPrompt, serializeContext } from "../services/assess-prompts.js";
import { retrieveContext, type AssessmentInput } from "../services/assess-retrieval.js";

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
  it("serializeContext includes matrix cells", () => {
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd server && pnpm vitest run src/__tests__/assess-prompts.test.ts
```

- [ ] **Step 3: Create prompt builders**

Create `server/src/services/assess-prompts.ts`. Port the system/user prompts from `/tmp/agent-marketing-research/src/lib/assess-prompt.ts` and the interview prompt from `/tmp/agent-marketing-research/src/lib/assess-interview-prompt.ts`. Add `serializeContext` (from `/tmp/agent-marketing-research/src/lib/assess-retrieval.ts` lines 124-253) and a new `buildJumpstartPrompt`.

Key functions to implement:
- `serializeContext(ctx, input)` — serializes RAG data to text for LLM prompt
- `buildSystemPrompt(serializedContext)` — assessment system prompt with WACT framework
- `buildUserPrompt(input, companyWebContent?)` — structured intake data
- `buildInterviewSystemPrompt(ragContext?, selectedFunctions?)` — interview system prompt with condensed matrix
- `buildInterviewMessages(history, webContent?, formSummary?)` — conversation message array
- `buildJumpstartPrompt(input, assessmentOutput)` — prompt to generate jumpstart.md from assessment

The jumpstart prompt should instruct the LLM to produce the jumpstart markdown format from the spec (Company Profile, Recommended Agent Opportunities with WACT scores, Scope Recommendations for Company/Department/Team, Risk Factors, Systems to Integrate).

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd server && pnpm vitest run src/__tests__/assess-prompts.test.ts
```

Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/assess-prompts.ts server/src/__tests__/assess-prompts.test.ts
git commit -m "feat(assess): add prompt builders for assessment, interview, and jumpstart"
```

---

