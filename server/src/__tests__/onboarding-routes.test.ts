import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock onboarding service ──────────────────────────────────────────────────

const mockOnboarding = vi.hoisted(() => ({
  createSession: vi.fn(async () => ({ id: "sess-1", status: "active" })),
  getSession: vi.fn(async () => ({ id: "sess-1", status: "active" })),
  updateSession: vi.fn(async () => ({ id: "sess-1", status: "updated" })),
  ingestSource: vi.fn(async () => ({ id: "src-1", type: "document" })),
  listSources: vi.fn(async () => [{ id: "src-1" }]),
  extractContext: vi.fn(async () => ({ extracted: true, items: [] })),
  listContext: vi.fn(async () => [{ id: "ctx-1" }]),
  updateContext: vi.fn(async () => ({ id: "ctx-1", updated: true })),
  suggestTeam: vi.fn(async () => [{ role: "engineer", count: 2 }]),
  applyTeam: vi.fn(async () => ({ applied: true, agentsCreated: 2 })),
  generatePlan: vi.fn(async () => ({ plan: { phases: [] } })),
  updatePlan: vi.fn(async () => ({ plan: { phases: [{ name: "Phase 1" }] } })),
  applyPlan: vi.fn(async () => ({ applied: true })),
  completeSession: vi.fn(async () => ({ id: "sess-1", status: "completed" })),
}));

vi.mock("../services/onboarding.js", () => ({
  onboardingService: () => mockOnboarding,
}));

import express from "express";
import request from "supertest";
import { onboardingRoutes } from "../routes/onboarding.js";
import { errorHandler } from "../middleware/index.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", onboardingRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("Onboarding routes", () => {
  let app: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  // ── Sessions ─────────────────────────────────────────────────────────

  describe("sessions", () => {
    it("POST /companies/:cid/onboarding/sessions creates a session", async () => {
      const res = await request(app)
        .post("/api/companies/company-1/onboarding/sessions")
        .send({})
        .expect(201);

      expect(res.body.id).toBe("sess-1");
      expect(res.body.status).toBe("active");
      expect(mockOnboarding.createSession).toHaveBeenCalledWith(
        "company-1",
        "local-board",
      );
    });

    it("GET /companies/:cid/onboarding/sessions/:id gets a session", async () => {
      const res = await request(app)
        .get("/api/companies/company-1/onboarding/sessions/sess-1")
        .expect(200);

      expect(res.body.id).toBe("sess-1");
      expect(res.body.status).toBe("active");
      expect(mockOnboarding.getSession).toHaveBeenCalledWith("sess-1");
    });

    it("PATCH /companies/:cid/onboarding/sessions/:id updates a session", async () => {
      const res = await request(app)
        .patch("/api/companies/company-1/onboarding/sessions/sess-1")
        .send({ status: "updated" })
        .expect(200);

      expect(res.body.id).toBe("sess-1");
      expect(res.body.status).toBe("updated");
      expect(mockOnboarding.updateSession).toHaveBeenCalledWith(
        "sess-1",
        expect.objectContaining({ status: "updated" }),
      );
    });
  });

  // ── Sources ──────────────────────────────────────────────────────────

  describe("sources", () => {
    it("POST /companies/:cid/onboarding/sessions/:id/sources ingests a source", async () => {
      const res = await request(app)
        .post("/api/companies/company-1/onboarding/sessions/sess-1/sources")
        .send({ type: "document", url: "https://example.com/doc.pdf" })
        .expect(201);

      expect(res.body.id).toBe("src-1");
      expect(res.body.type).toBe("document");
      expect(mockOnboarding.ingestSource).toHaveBeenCalledWith(
        "company-1",
        "sess-1",
        expect.objectContaining({ type: "document" }),
      );
    });

    it("GET /companies/:cid/onboarding/sessions/:id/sources lists sources", async () => {
      const res = await request(app)
        .get("/api/companies/company-1/onboarding/sessions/sess-1/sources")
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe("src-1");
      expect(mockOnboarding.listSources).toHaveBeenCalledWith(
        "company-1",
        "sess-1",
      );
    });
  });

  // ── Extract ──────────────────────────────────────────────────────────

  describe("extract", () => {
    it("POST /companies/:cid/onboarding/sessions/:id/extract extracts context", async () => {
      const res = await request(app)
        .post("/api/companies/company-1/onboarding/sessions/sess-1/extract")
        .send({})
        .expect(200);

      expect(res.body.extracted).toBe(true);
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(mockOnboarding.extractContext).toHaveBeenCalledWith(
        "company-1",
        "sess-1",
      );
    });
  });

  // ── Context ──────────────────────────────────────────────────────────

  describe("context", () => {
    it("GET /companies/:cid/context lists context items", async () => {
      const res = await request(app)
        .get("/api/companies/company-1/context")
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe("ctx-1");
      expect(mockOnboarding.listContext).toHaveBeenCalledWith("company-1");
    });

    it("PATCH /companies/:cid/context/:id updates a context item", async () => {
      const res = await request(app)
        .patch("/api/companies/company-1/context/ctx-1")
        .send({ value: "updated value" })
        .expect(200);

      expect(res.body.id).toBe("ctx-1");
      expect(res.body.updated).toBe(true);
      expect(mockOnboarding.updateContext).toHaveBeenCalledWith(
        "ctx-1",
        expect.objectContaining({ value: "updated value" }),
      );
    });
  });

  // ── Team ─────────────────────────────────────────────────────────────

  describe("team", () => {
    it("POST /companies/:cid/onboarding/sessions/:id/suggest-team suggests team", async () => {
      const res = await request(app)
        .post(
          "/api/companies/company-1/onboarding/sessions/sess-1/suggest-team",
        )
        .send({})
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0].role).toBe("engineer");
      expect(res.body[0].count).toBe(2);
      expect(mockOnboarding.suggestTeam).toHaveBeenCalledWith(
        "company-1",
        "sess-1",
      );
    });

    it("POST /companies/:cid/onboarding/sessions/:id/apply-team applies team", async () => {
      const res = await request(app)
        .post("/api/companies/company-1/onboarding/sessions/sess-1/apply-team")
        .send({ suggestions: [{ role: "engineer", count: 2 }] })
        .expect(201);

      expect(res.body.applied).toBe(true);
      expect(res.body.agentsCreated).toBe(2);
      expect(mockOnboarding.applyTeam).toHaveBeenCalledWith(
        "company-1",
        [{ role: "engineer", count: 2 }],
      );
    });
  });

  // ── Plan ─────────────────────────────────────────────────────────────

  describe("plan", () => {
    it("POST /companies/:cid/onboarding/sessions/:id/generate-plan generates a plan", async () => {
      const res = await request(app)
        .post(
          "/api/companies/company-1/onboarding/sessions/sess-1/generate-plan",
        )
        .send({})
        .expect(200);

      expect(res.body.plan).toBeDefined();
      expect(Array.isArray(res.body.plan.phases)).toBe(true);
      expect(mockOnboarding.generatePlan).toHaveBeenCalledWith(
        "company-1",
        "sess-1",
      );
    });

    it("PATCH /companies/:cid/onboarding/sessions/:id/plan updates a plan", async () => {
      const res = await request(app)
        .patch("/api/companies/company-1/onboarding/sessions/sess-1/plan")
        .send({ phases: [{ name: "Phase 1" }] })
        .expect(200);

      expect(res.body.plan.phases).toHaveLength(1);
      expect(res.body.plan.phases[0].name).toBe("Phase 1");
      expect(mockOnboarding.updatePlan).toHaveBeenCalledWith(
        "company-1",
        "sess-1",
        expect.objectContaining({ phases: [{ name: "Phase 1" }] }),
      );
    });

    it("POST /companies/:cid/onboarding/sessions/:id/apply-plan applies a plan", async () => {
      const res = await request(app)
        .post("/api/companies/company-1/onboarding/sessions/sess-1/apply-plan")
        .send({})
        .expect(200);

      expect(res.body.applied).toBe(true);
      expect(mockOnboarding.applyPlan).toHaveBeenCalledWith(
        "company-1",
        "sess-1",
      );
    });
  });

  // ── Complete ─────────────────────────────────────────────────────────

  describe("complete", () => {
    it("POST /companies/:cid/onboarding/sessions/:id/complete completes a session", async () => {
      const res = await request(app)
        .post("/api/companies/company-1/onboarding/sessions/sess-1/complete")
        .send({})
        .expect(200);

      expect(res.body.id).toBe("sess-1");
      expect(res.body.status).toBe("completed");
      expect(mockOnboarding.completeSession).toHaveBeenCalledWith("sess-1");
    });
  });
});
