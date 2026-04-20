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
        source: "jwt",
        isInstanceAdmin: false,
      });
      await request(app).get("/api/companies/company-1/assess").expect(403);
    });
  });
});
