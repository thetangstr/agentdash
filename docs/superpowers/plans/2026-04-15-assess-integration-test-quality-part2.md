## Task 4: Assess Core Service

**Files:**
- Create: `server/src/services/assess.ts`
- Test: `server/src/__tests__/assess-service.test.ts`

- [ ] **Step 1: Write failing tests**

Create `server/src/__tests__/assess-service.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock global fetch for MiniMax calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { assessService } from "../services/assess.js";

// Minimal mock DB
const mockDb = {
  insert: vi.fn().mockReturnThis(),
  values: vi.fn().mockReturnThis(),
  onConflictDoUpdate: vi.fn().mockReturnThis(),
  returning: vi.fn().mockResolvedValue([{ id: "ctx-1" }]),
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockResolvedValue([]),
} as any;

describe("assessService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ASSESS_MINIMAX_API_KEY = "test-key";
  });

  describe("research", () => {
    it("fetches a URL and detects industry", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => "<html><body>We are a healthcare company providing hospital management</body></html>",
      });

      const svc = assessService(mockDb);
      const result = await svc.research("https://example.com", "Example Corp");

      expect(result.suggestedIndustry).toBe("Healthcare");
      expect(result.summary).toBeTruthy();
      expect(result.webContent).toContain("healthcare");
      expect(result.allIndustries.length).toBe(18);
    });

    it("returns empty on fetch failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const svc = assessService(mockDb);
      const result = await svc.research("https://bad-url.com", "Bad Corp");

      expect(result.suggestedIndustry).toBe("");
      expect(result.webContent).toBe("");
    });
  });

  describe("interview", () => {
    it("calls MiniMax and returns parsed JSON", async () => {
      const llmResponse = {
        content: [
          { type: "text", text: JSON.stringify({
            question: "How structured are your workflows?",
            options: ["Very structured", "Mixed", "Ad hoc"],
            insights: [],
            clarityScore: 30,
            done: false,
          }) },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => llmResponse,
      });

      const svc = assessService(mockDb);
      const result = await svc.interview({
        conversationHistory: [],
        industry: "Healthcare",
        industrySlug: "healthcare",
        formSummary: "Company: Test Corp",
        selectedFunctions: [],
      });

      expect(result.question).toBeTruthy();
      expect(result.done).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("throws when API key is missing", async () => {
      delete process.env.ASSESS_MINIMAX_API_KEY;
      const svc = assessService(mockDb);
      await expect(
        svc.interview({ conversationHistory: [], industry: "Healthcare", industrySlug: "healthcare", formSummary: "", selectedFunctions: [] }),
      ).rejects.toThrow("ASSESS_MINIMAX_API_KEY");
    });
  });

  describe("getAssessment", () => {
    it("returns null when no assessment exists", async () => {
      mockDb.where.mockResolvedValueOnce([]);
      const svc = assessService(mockDb);
      const result = await svc.getAssessment("company-1");
      expect(result).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd server && pnpm vitest run src/__tests__/assess-service.test.ts
```

- [ ] **Step 3: Create the assess service**

Create `server/src/services/assess.ts`:

```typescript
/**
 * Agent Readiness Assessment service.
 * Uses MiniMax (Anthropic-compatible API) — runs before customer keys are configured.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "@agentdash/db";
import { companyContext } from "@agentdash/db";
import { logger } from "../middleware/logger.js";
import { retrieveContext, type AssessmentInput } from "./assess-retrieval.js";
import {
  serializeContext,
  buildSystemPrompt,
  buildUserPrompt,
  buildInterviewSystemPrompt,
  buildInterviewMessages,
  buildJumpstartPrompt,
} from "./assess-prompts.js";

const MINIMAX_BASE_URL = process.env.ASSESS_MINIMAX_BASE_URL ?? "https://api.minimaxi.com/anthropic";
const MINIMAX_MODEL = process.env.ASSESS_MINIMAX_MODEL ?? "MiniMax-M2.7-highspeed";

function getApiKey(): string {
  const key = process.env.ASSESS_MINIMAX_API_KEY?.trim();
  if (!key) throw Object.assign(new Error("ASSESS_MINIMAX_API_KEY is not configured"), { statusCode: 503 });
  return key;
}

const INDUSTRIES = [
  "Public Sector", "E-Commerce", "Insurance", "Healthcare", "Logistics",
  "Financial Services", "Manufacturing", "Real Estate", "Legal", "Education",
  "Tech/SaaS", "Retail", "Energy/Utilities", "Telecom",
  "Media/Entertainment", "Construction", "Hospitality", "Agriculture",
];

const INDUSTRY_KEYWORDS: Record<string, string[]> = {
  Healthcare: ["health", "medical", "hospital", "clinical", "patient", "pharma", "biotech"],
  "Financial Services": ["bank", "financial", "investment", "wealth", "capital", "fintech"],
  Insurance: ["insurance", "underwriting", "claims", "policyholder"],
  "E-Commerce": ["shop", "store", "cart", "ecommerce", "e-commerce", "marketplace"],
  Retail: ["retail", "apparel", "footwear", "fashion", "clothing"],
  "Tech/SaaS": ["software", "saas", "platform", "cloud", "api", "developer"],
  Logistics: ["logistics", "shipping", "freight", "supply chain", "warehouse"],
  Manufacturing: ["manufacturing", "factory", "production", "assembly"],
  Construction: ["construction", "building", "architecture"],
  "Real Estate": ["real estate", "property", "realty"],
  Legal: ["law firm", "legal", "attorney", "counsel"],
  Education: ["education", "university", "school", "learning"],
  "Public Sector": ["government", "federal", "public sector", "municipal"],
  "Energy/Utilities": ["energy", "utility", "oil", "gas", "renewable", "solar"],
  Telecom: ["telecom", "wireless", "mobile", "network"],
  "Media/Entertainment": ["media", "entertainment", "streaming", "content"],
  Hospitality: ["hotel", "hospitality", "restaurant", "travel"],
  Agriculture: ["agriculture", "farming", "crop", "livestock"],
};

function detectIndustry(text: string): string {
  const lower = text.toLowerCase();
  const scores: { industry: string; count: number }[] = [];
  for (const [industry, keywords] of Object.entries(INDUSTRY_KEYWORDS)) {
    const count = keywords.filter((kw) => lower.includes(kw)).length;
    if (count > 0) scores.push({ industry, count });
  }
  scores.sort((a, b) => b.count - a.count);
  return scores[0]?.industry ?? "";
}

function extractSummary(text: string): string {
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 30);
  return sentences.slice(0, 3).join(". ").trim().slice(0, 300) + (sentences.length > 3 ? "..." : ".");
}

async function fetchWebsite(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "AgentDash-Assess/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return "";
    const html = await res.text();
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

export function assessService(db: Db) {
  return {
    async research(companyUrl: string, companyName: string) {
      let normalizedUrl = companyUrl;
      if (normalizedUrl && !normalizedUrl.startsWith("http")) normalizedUrl = "https://" + normalizedUrl;

      const websiteText = normalizedUrl ? await fetchWebsite(normalizedUrl) : "";
      return {
        companyName,
        suggestedIndustry: detectIndustry(websiteText),
        summary: extractSummary(websiteText),
        webContent: websiteText.slice(0, 3000),
        allIndustries: INDUSTRIES,
      };
    },

    async interview(params: {
      conversationHistory: Array<{ role: "assistant" | "user"; content: string }>;
      companyWebContent?: string;
      industry: string;
      industrySlug: string;
      formSummary: string;
      selectedFunctions: string[];
    }) {
      const apiKey = getApiKey();

      let ragContext: string | undefined;
      if (params.industrySlug) {
        const input: AssessmentInput = {
          companyName: "", industry: params.industry, industrySlug: params.industrySlug,
          employeeRange: "", revenueRange: "", description: "", currentSystems: "",
          automationLevel: "", challenges: "", selectedFunctions: params.selectedFunctions,
          primaryGoal: "", targets: "", timeline: "", budgetRange: "",
          aiUsageLevel: "", aiGovernance: "", agentExperience: "", aiOwnership: "",
        };
        const ctx = retrieveContext(input);
        if (ctx.matrixCells.length > 0) ragContext = serializeContext(ctx, input);
      }

      const systemPrompt = buildInterviewSystemPrompt(ragContext, params.selectedFunctions);
      const messages = buildInterviewMessages(
        params.conversationHistory,
        params.companyWebContent,
        params.formSummary,
      );

      const res = await fetch(`${MINIMAX_BASE_URL}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MINIMAX_MODEL,
          max_tokens: 4096,
          temperature: 1.0,
          system: systemPrompt,
          messages,
          thinking: { type: "enabled", budget_tokens: 8000 },
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "unknown");
        throw Object.assign(new Error(`MiniMax error ${res.status}: ${errText}`), { statusCode: 502 });
      }

      const data = await res.json() as { content: Array<{ type: string; text?: string }> };
      const responseText = data.content
        ?.filter((b) => b.type === "text")
        ?.map((b) => b.text)
        ?.join("") ?? "";

      // Parse JSON response
      const cleaned = responseText.replace(/^```json?\s*/i, "").replace(/\s*```$/i, "").trim();
      try {
        return JSON.parse(cleaned);
      } catch {
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try { return JSON.parse(jsonMatch[0]); } catch { /* fall through */ }
        }
        return {
          question: "Could you tell me what your organization does and what industry you're in?",
          options: ["Healthcare", "Financial Services", "Technology/SaaS", "Another industry"],
          insights: [],
          clarityScore: 0,
          done: false,
        };
      }
    },

    async runAssessment(companyId: string, input: AssessmentInput, companyWebContent?: string) {
      const apiKey = getApiKey();

      const ctx = retrieveContext(input);
      const serialized = serializeContext(ctx, input);
      const systemPrompt = buildSystemPrompt(serialized);
      const userPrompt = buildUserPrompt(input, companyWebContent);

      // Streaming call to MiniMax
      const upstreamRes = await fetch(`${MINIMAX_BASE_URL}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MINIMAX_MODEL,
          max_tokens: 16000,
          temperature: 1.0,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
          stream: true,
          thinking: { type: "enabled", budget_tokens: 10000 },
        }),
      });

      if (!upstreamRes.ok) {
        const text = await upstreamRes.text().catch(() => "unknown");
        throw Object.assign(new Error(`MiniMax error ${upstreamRes.status}: ${text}`), { statusCode: 502 });
      }

      return {
        stream: upstreamRes.body!,
        onComplete: async (fullOutput: string) => {
          // Store assessment report
          await db.insert(companyContext).values({
            companyId,
            contextType: "agent_research",
            key: "readiness-assessment",
            value: fullOutput,
            confidence: "0.95",
          }).onConflictDoUpdate({
            target: [companyContext.companyId, companyContext.contextType, companyContext.key],
            set: { value: fullOutput, confidence: "0.95", updatedAt: new Date() },
          });

          // Store input
          await db.insert(companyContext).values({
            companyId,
            contextType: "agent_research",
            key: "assessment-input",
            value: JSON.stringify(input),
            confidence: "0.99",
          }).onConflictDoUpdate({
            target: [companyContext.companyId, companyContext.contextType, companyContext.key],
            set: { value: JSON.stringify(input), updatedAt: new Date() },
          });

          // Generate jumpstart via second MiniMax call
          try {
            const jumpstartPrompt = buildJumpstartPrompt(input, fullOutput);
            const jumpstartRes = await fetch(`${MINIMAX_BASE_URL}/v1/messages`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
              },
              body: JSON.stringify({
                model: MINIMAX_MODEL,
                max_tokens: 8000,
                temperature: 0.7,
                system: "You produce structured jumpstart documents for AgentDash.",
                messages: [{ role: "user", content: jumpstartPrompt }],
              }),
            });

            if (jumpstartRes.ok) {
              const jumpstartData = await jumpstartRes.json() as { content: Array<{ type: string; text?: string }> };
              const jumpstartMd = jumpstartData.content
                ?.filter((b) => b.type === "text")
                ?.map((b) => b.text)
                ?.join("") ?? "";

              if (jumpstartMd) {
                await db.insert(companyContext).values({
                  companyId,
                  contextType: "agent_research",
                  key: "jumpstart",
                  value: jumpstartMd,
                  confidence: "0.90",
                }).onConflictDoUpdate({
                  target: [companyContext.companyId, companyContext.contextType, companyContext.key],
                  set: { value: jumpstartMd, updatedAt: new Date() },
                });
              }
            }
          } catch (err) {
            logger.warn({ err }, "Failed to generate jumpstart — assessment still saved");
          }
        },
      };
    },

    async getAssessment(companyId: string) {
      const rows = await db.select().from(companyContext).where(
        and(eq(companyContext.companyId, companyId), eq(companyContext.contextType, "agent_research")),
      );
      const markdownRow = rows.find((r: any) => r.key === "readiness-assessment");
      const jumpstartRow = rows.find((r: any) => r.key === "jumpstart");
      const inputRow = rows.find((r: any) => r.key === "assessment-input");
      if (!markdownRow) return null;
      return {
        markdown: markdownRow.value,
        jumpstart: jumpstartRow?.value ?? null,
        assessmentInput: inputRow?.value ? JSON.parse(inputRow.value) : null,
      };
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd server && pnpm vitest run src/__tests__/assess-service.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/assess.ts server/src/__tests__/assess-service.test.ts
git commit -m "feat(assess): add core assess service with MiniMax integration"
```

---

## Task 5: Assess Routes

**Files:**
- Create: `server/src/routes/assess.ts`
- Test: `server/src/__tests__/assess-routes.test.ts`

- [ ] **Step 1: Write failing tests**

Create `server/src/__tests__/assess-routes.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAssess = vi.hoisted(() => ({
  research: vi.fn(async () => ({
    companyName: "Test Corp",
    suggestedIndustry: "Healthcare",
    summary: "A hospital company",
    webContent: "healthcare hospital patient",
    allIndustries: ["Healthcare", "Tech/SaaS"],
  })),
  interview: vi.fn(async () => ({
    question: "How structured?",
    options: ["Very", "Mixed"],
    insights: [],
    clarityScore: 30,
    done: false,
  })),
  runAssessment: vi.fn(async () => ({
    stream: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("# Report")); c.close(); } }),
    onComplete: vi.fn(),
  })),
  getAssessment: vi.fn(async () => ({
    markdown: "# Report",
    jumpstart: "# Jumpstart",
    assessmentInput: {},
  })),
}));

vi.mock("../services/assess.js", () => ({
  assessService: () => mockAssess,
}));

import express from "express";
import request from "supertest";
import { assessRoutes } from "../routes/assess.js";
import { errorHandler } from "../middleware/index.js";

function createApp(actor?: any) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", assessRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("Assess routes", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("POST /companies/:cid/assess/research", () => {
    it("returns research results", async () => {
      const app = createApp();
      const res = await request(app)
        .post("/api/companies/company-1/assess/research")
        .send({ companyUrl: "https://example.com", companyName: "Test Corp" })
        .expect(200);

      expect(res.body.suggestedIndustry).toBe("Healthcare");
      expect(mockAssess.research).toHaveBeenCalledWith("https://example.com", "Test Corp");
    });

    it("rejects without board auth", async () => {
      const app = createApp({ type: "none", companyIds: [] });
      await request(app)
        .post("/api/companies/company-1/assess/research")
        .send({ companyUrl: "https://example.com" })
        .expect(403);
    });
  });

  describe("POST /companies/:cid/assess/interview", () => {
    it("returns interview question", async () => {
      const app = createApp();
      const res = await request(app)
        .post("/api/companies/company-1/assess/interview")
        .send({ conversationHistory: [], industry: "Healthcare", industrySlug: "healthcare", formSummary: "", selectedFunctions: [] })
        .expect(200);

      expect(res.body.question).toBe("How structured?");
    });
  });

  describe("GET /companies/:cid/assess", () => {
    it("returns stored assessment", async () => {
      const app = createApp();
      const res = await request(app)
        .get("/api/companies/company-1/assess")
        .expect(200);

      expect(res.body.markdown).toBe("# Report");
      expect(res.body.jumpstart).toBe("# Jumpstart");
    });

    it("returns 404 when no assessment", async () => {
      mockAssess.getAssessment.mockResolvedValueOnce(null);
      const app = createApp();
      await request(app).get("/api/companies/company-1/assess").expect(404);
    });

    it("rejects wrong company access", async () => {
      const app = createApp({
        type: "board",
        userId: "user-1",
        companyIds: ["other-company"],
        source: "local_implicit",
        isInstanceAdmin: false,
      });
      await request(app).get("/api/companies/company-1/assess").expect(403);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd server && pnpm vitest run src/__tests__/assess-routes.test.ts
```

- [ ] **Step 3: Create the routes**

Create `server/src/routes/assess.ts`:

```typescript
import { Router } from "express";
import type { Db } from "@agentdash/db";
import { assessService } from "../services/assess.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function assessRoutes(db: Db) {
  const router = Router();
  const svc = assessService(db);

  // POST /companies/:companyId/assess/research — lightweight URL research
  router.post("/companies/:companyId/assess/research", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const { companyUrl, companyName } = req.body;
      const result = await svc.research(companyUrl ?? "", companyName ?? "");
      res.json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  // POST /companies/:companyId/assess/interview — WACT interview round
  router.post("/companies/:companyId/assess/interview", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.interview(req.body);
      res.json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  // POST /companies/:companyId/assess — run full assessment (streaming)
  router.post("/companies/:companyId/assess", async (req, res) => {
    try {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const { stream, onComplete } = await svc.runAssessment(companyId, req.body, req.body.companyWebContent);

      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("X-Content-Type-Options", "nosniff");

      const reader = (stream as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let fullOutput = "";

      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          // Parse SSE lines for content_block_delta text
          for (const line of chunk.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ")) continue;
            const data = trimmed.slice(6);
            if (data === "[DONE]") continue;
            try {
              const json = JSON.parse(data);
              if (json.type === "content_block_delta" && json.delta?.text) {
                fullOutput += json.delta.text;
                res.write(json.delta.text);
              }
            } catch { /* skip non-JSON lines */ }
          }
        }
      };

      await pump();
      res.end();

      // Fire-and-forget: store results + generate jumpstart
      onComplete(fullOutput).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : "unknown";
        console.error("assess onComplete error:", msg);
      });
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      if (!res.headersSent) res.status(status).json({ error: message });
    }
  });

  // GET /companies/:companyId/assess — get stored assessment
  router.get("/companies/:companyId/assess", async (req, res) => {
    try {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const result = await svc.getAssessment(companyId);
      if (!result) { res.status(404).json({ error: "No assessment found" }); return; }
      res.json(result);
    } catch (err: unknown) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      const message = err instanceof Error ? err.message : "Internal server error";
      res.status(status).json({ error: message });
    }
  });

  return router;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd server && pnpm vitest run src/__tests__/assess-routes.test.ts
```

Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/assess.ts server/src/__tests__/assess-routes.test.ts
git commit -m "feat(assess): add assess routes with tests"
```

---

