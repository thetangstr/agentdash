import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock services ───────────────────────────────────────────────────────

const mockAgentFactory = vi.hoisted(() => ({
  listTemplates: vi.fn(async () => []),
  getTemplateById: vi.fn(async () => null),
  createTemplate: vi.fn(async () => ({ id: "tpl-1", slug: "eng", name: "Engineer" })),
  updateTemplate: vi.fn(async () => ({ id: "tpl-1", slug: "eng", name: "Engineer v2" })),
  archiveTemplate: vi.fn(async () => ({ id: "tpl-1", archived: true })),
}));

const mockSecurity = vi.hoisted(() => ({
  createPolicy: vi.fn(async () => ({
    id: "pol-1",
    name: "No prod deploys",
    policyType: "action_limit",
  })),
  listPolicies: vi.fn(async () => []),
  getPolicyById: vi.fn(async () => null),
  updatePolicy: vi.fn(async () => ({ id: "pol-1", isActive: false })),
  deactivatePolicy: vi.fn(async () => ({ id: "pol-1", isActive: false })),
  listPolicyEvaluations: vi.fn(async () => []),
  configureSandbox: vi.fn(async () => ({ id: "sb-1" })),
  getSandbox: vi.fn(async () => null),
  activateKillSwitch: vi.fn(async () => ({ id: "ks-1", action: "halt" })),
  resumeFromKillSwitch: vi.fn(async () => ({ id: "ks-2", action: "resume" })),
  getKillSwitchStatus: vi.fn(async () => ({ active: false })),
}));

const mockPipeline = vi.hoisted(() => ({
  list: vi.fn(async () => []),
  listAll: vi.fn(async () => []),
  get: vi.fn(async () => null),
  create: vi.fn(async () => ({
    id: "pipe-1",
    name: "RFP Response",
    status: "draft",
    stages: [],
    edges: [],
  })),
  update: vi.fn(async () => ({ id: "pipe-1", status: "active" })),
  delete: vi.fn(async () => ({ id: "pipe-1", status: "archived" })),
  createRun: vi.fn(async () => ({ id: "run-1", status: "pending" })),
  listRuns: vi.fn(async () => []),
  getRun: vi.fn(async () => ({ id: "run-1", status: "running", pipelineId: "pipe-1" })),
  getStageExecutions: vi.fn(async () => []),
  cancelRun: vi.fn(async () => ({ id: "run-1", status: "cancelled" })),
}));

const mockRunner = vi.hoisted(() => ({
  startRun: vi.fn(async () => ({})),
  onStageCompleted: vi.fn(async () => undefined),
  onHitlDecision: vi.fn(async () => undefined),
  onStageFailed: vi.fn(async () => undefined),
}));

vi.mock("../services/agent-factory.js", () => ({
  agentFactoryService: () => mockAgentFactory,
}));

vi.mock("../services/policy-engine.js", () => ({
  policyEngineService: () => mockSecurity,
}));

vi.mock("../services/pipeline-orchestrator.js", () => ({
  pipelineOrchestratorService: () => mockPipeline,
  validatePipelineDag: vi.fn(),
}));

vi.mock("../services/pipeline-runner.js", () => ({
  pipelineRunnerService: () => mockRunner,
}));

import express from "express";
import request from "supertest";
import { agentTemplateRoutes } from "../routes/agent-templates.js";
import { securityRoutes } from "../routes/security.js";
import { pipelineRoutes } from "../routes/pipelines.js";
import { errorHandler } from "../middleware/index.js";

function createApp(routeFn: (db: any) => express.Router) {
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
  app.use("/api", routeFn({} as any));
  app.use(errorHandler);
  return app;
}

describe("AgentDash CUJ routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Agent Templates (CUJ-3) ────────────────────────────────────────

  describe("agent templates", () => {
    let app: express.Express;
    beforeEach(() => {
      app = createApp(agentTemplateRoutes);
    });

    it("GET /companies/:cid/agent-templates lists templates", async () => {
      mockAgentFactory.listTemplates.mockResolvedValue([
        { id: "tpl-1", slug: "eng", name: "Engineer" },
        { id: "tpl-2", slug: "qa", name: "QA" },
      ]);

      const res = await request(app)
        .get("/api/companies/company-1/agent-templates")
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(2);
    });

    it("POST /companies/:cid/agent-templates creates a template (201)", async () => {
      const res = await request(app)
        .post("/api/companies/company-1/agent-templates")
        .send({
          slug: "eng",
          name: "Engineer",
          role: "engineer",
          adapterType: "opencode_local",
          budgetMonthlyCents: 5000,
        })
        .expect(201);

      expect(res.body.id).toBe("tpl-1");
      expect(mockAgentFactory.createTemplate).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ slug: "eng" }),
      );
    });

    it("GET /companies/:cid/agent-templates/:id returns 404 when not found", async () => {
      mockAgentFactory.getTemplateById.mockResolvedValue(null);

      await request(app)
        .get("/api/companies/company-1/agent-templates/nonexistent")
        .expect(404);
    });

    it("GET /companies/:cid/agent-templates/:id returns template when found", async () => {
      mockAgentFactory.getTemplateById.mockResolvedValue({
        id: "tpl-1",
        slug: "eng",
        name: "Engineer",
      });

      const res = await request(app)
        .get("/api/companies/company-1/agent-templates/tpl-1")
        .expect(200);

      expect(res.body.id).toBe("tpl-1");
    });
  });

  // ── Security Policies (CUJ-5, CUJ-9) ──────────────────────────────

  describe("security policies", () => {
    let app: express.Express;
    beforeEach(() => {
      app = createApp(securityRoutes);
    });

    it("GET /companies/:cid/security-policies lists policies", async () => {
      mockSecurity.listPolicies.mockResolvedValue([
        { id: "pol-1", name: "No prod", policyType: "action_limit" },
      ]);

      const res = await request(app)
        .get("/api/companies/company-1/security-policies")
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
    });

    it("POST /companies/:cid/security-policies creates a policy", async () => {
      const res = await request(app)
        .post("/api/companies/company-1/security-policies")
        .send({
          name: "No prod deploys",
          policyType: "action_limit",
          targetType: "company",
          rules: {},
          effect: "deny",
        })
        .expect(201);

      expect(res.body.id).toBe("pol-1");
    });

    it("POST /companies/:cid/kill-switch halts agents", async () => {
      const res = await request(app)
        .post("/api/companies/company-1/kill-switch")
        .send({ scope: "company", reason: "Emergency" })
        .expect(201);

      expect(res.body.action).toBe("halt");
      expect(mockSecurity.activateKillSwitch).toHaveBeenCalled();
    });

    it("POST /companies/:cid/kill-switch/resume resumes agents", async () => {
      const res = await request(app)
        .post("/api/companies/company-1/kill-switch/resume")
        .send({ scope: "company" })
        .expect(200);

      expect(res.body.action).toBe("resume");
    });

    it("GET /companies/:cid/kill-switch/status returns status", async () => {
      mockSecurity.getKillSwitchStatus.mockResolvedValue({ active: true, since: "2026-01-01" });

      const res = await request(app)
        .get("/api/companies/company-1/kill-switch/status")
        .expect(200);

      expect(res.body.active).toBe(true);
    });
  });

  // ── Pipeline Orchestration (CUJ-6) ────────────────────────────────

  describe("pipeline orchestration", () => {
    let app: express.Express;
    beforeEach(() => {
      app = createApp(pipelineRoutes);
    });

    it("GET /companies/:cid/pipelines lists pipelines", async () => {
      mockPipeline.list.mockResolvedValue([
        { id: "pipe-1", name: "RFP Response", status: "active" },
      ]);

      const res = await request(app)
        .get("/api/companies/company-1/pipelines")
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
    });

    it("PATCH /companies/:cid/pipelines/:id updates a pipeline", async () => {
      const res = await request(app)
        .patch("/api/companies/company-1/pipelines/pipe-1")
        .send({ status: "active" })
        .expect(200);

      expect(res.body.status).toBe("active");
    });

    it("DELETE /companies/:cid/pipelines/:id archives a pipeline", async () => {
      await request(app)
        .delete("/api/companies/company-1/pipelines/pipe-1")
        .expect(200);

      expect(mockPipeline.delete).toHaveBeenCalledWith("company-1", "pipe-1");
    });

    it("GET /companies/:cid/pipelines/:id/runs lists runs", async () => {
      mockPipeline.listRuns.mockResolvedValue([
        { id: "run-1", status: "running" },
        { id: "run-2", status: "completed" },
      ]);

      const res = await request(app)
        .get("/api/companies/company-1/pipelines/pipe-1/runs")
        .expect(200);

      expect(res.body).toHaveLength(2);
    });

    it("POST /companies/:cid/pipeline-runs/:id/cancel cancels a run", async () => {
      const res = await request(app)
        .post("/api/companies/company-1/pipeline-runs/run-1/cancel")
        .expect(200);

      expect(res.body.status).toBe("cancelled");
    });

    it("POST .../stages/:sid/decide handles HITL decision", async () => {
      await request(app)
        .post("/api/companies/company-1/pipeline-runs/run-1/stages/s1/decide")
        .send({ decision: "approved", notes: "Looks good" })
        .expect(200);

      expect(mockRunner.onHitlDecision).toHaveBeenCalledWith(
        "run-1",
        "s1",
        "approved",
        "Looks good",
      );
    });

    it("GET /companies/:cid/pipeline-runs/:id returns run with stages", async () => {
      mockPipeline.getRun.mockResolvedValue({ id: "run-1", status: "running" });
      mockPipeline.getStageExecutions.mockResolvedValue([
        { id: "se-1", stageId: "s1", status: "completed" },
      ]);

      const res = await request(app)
        .get("/api/companies/company-1/pipeline-runs/run-1")
        .expect(200);

      expect(res.body.id).toBe("run-1");
      expect(res.body.stages).toHaveLength(1);
    });
  });
});
