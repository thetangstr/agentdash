import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { autoresearchRoutes } from "../routes/autoresearch.js";
import { errorHandler } from "../middleware/index.js";

const companyId = "company-1";
const cycleId = "cycle-1";
const experimentId = "exp-1";

const mockAutoresearch = vi.hoisted(() => ({
  listCycles: vi.fn(async () => []),
  createCycle: vi.fn(async () => ({ id: "cycle-1", name: "Q1 Research", status: "active" })),
  getCycleById: vi.fn(async () => ({ id: "cycle-1", name: "Q1 Research" })),
  updateCycle: vi.fn(async () => ({ id: "cycle-1", status: "completed" })),
  listHypotheses: vi.fn(async () => []),
  createHypothesis: vi.fn(async () => ({ id: "hyp-1", statement: "Users prefer X" })),
  updateHypothesis: vi.fn(async () => ({ id: "hyp-1", status: "validated" })),
  listExperiments: vi.fn(async () => []),
  createExperiment: vi.fn(async () => ({ id: "exp-1", name: "A/B test" })),
  getExperimentById: vi.fn(async () => ({ id: "exp-1", name: "A/B test" })),
  updateExperiment: vi.fn(async () => ({ id: "exp-1", status: "running" })),
  abortExperiment: vi.fn(async () => ({ id: "exp-1", status: "aborted" })),
  listMetricDefinitions: vi.fn(async () => []),
  createMetricDefinition: vi.fn(async () => ({ id: "md-1", key: "conversion_rate" })),
  updateMetricDefinition: vi.fn(async () => ({ id: "md-1", key: "conversion_rate_v2" })),
  listMeasurements: vi.fn(async () => []),
  recordMeasurement: vi.fn(async () => ({ id: "meas-1", value: 42 })),
  getMetricTimeSeries: vi.fn(async () => ({ key: "conversion_rate", points: [] })),
  listEvaluations: vi.fn(async () => []),
  createEvaluation: vi.fn(async () => ({ id: "eval-1", verdict: "significant" })),
  getEvaluationById: vi.fn(async () => ({ id: "eval-1", verdict: "significant" })),
}));

vi.mock("../services/autoresearch.js", () => ({
  autoresearchService: () => mockAutoresearch,
}));

// Bypass tier gating — entitlement enforcement is covered by require-tier.test.ts
vi.mock("../services/entitlements.js", () => ({
  entitlementsService: () => ({
    getTier: async () => "enterprise",
    setTier: async () => undefined,
    getEntitlements: async () => ({
      tier: "enterprise",
      limits: { agents: 1000, monthlyActions: 5_000_000, pipelines: 1000 },
      features: {
        hubspotSync: true,
        autoResearch: true,
        assessMode: true,
        prioritySupport: true,
      },
    }),
  }),
}));

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
  app.use(autoresearchRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("autoresearch routes", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  describe("cycles", () => {
    it("GET /companies/:cid/research-cycles returns 200 with list", async () => {
      const res = await request(app).get(`/companies/${companyId}/research-cycles`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
      expect(mockAutoresearch.listCycles).toHaveBeenCalledWith(companyId, undefined);
    });

    it("GET /companies/:cid/research-cycles forwards status query param", async () => {
      const res = await request(app).get(`/companies/${companyId}/research-cycles?status=active`);
      expect(res.status).toBe(200);
      expect(mockAutoresearch.listCycles).toHaveBeenCalledWith(companyId, "active");
    });

    it("POST /companies/:cid/research-cycles returns 201 with created cycle", async () => {
      const res = await request(app)
        .post(`/companies/${companyId}/research-cycles`)
        .send({ name: "Q1 Research" });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ id: "cycle-1", name: "Q1 Research", status: "active" });
      expect(mockAutoresearch.createCycle).toHaveBeenCalledWith(companyId, { name: "Q1 Research" });
    });

    it("GET /companies/:cid/research-cycles/:id returns 200 with cycle", async () => {
      const res = await request(app).get(`/companies/${companyId}/research-cycles/${cycleId}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: "cycle-1", name: "Q1 Research" });
      expect(mockAutoresearch.getCycleById).toHaveBeenCalledWith(cycleId);
    });

    it("PATCH /companies/:cid/research-cycles/:id returns 200 with updated cycle", async () => {
      const res = await request(app)
        .patch(`/companies/${companyId}/research-cycles/${cycleId}`)
        .send({ status: "completed" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: "cycle-1", status: "completed" });
      expect(mockAutoresearch.updateCycle).toHaveBeenCalledWith(cycleId, { status: "completed" });
    });
  });

  describe("hypotheses", () => {
    it("GET /companies/:cid/research-cycles/:cycleId/hypotheses returns 200 with list", async () => {
      const res = await request(app).get(
        `/companies/${companyId}/research-cycles/${cycleId}/hypotheses`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
      expect(mockAutoresearch.listHypotheses).toHaveBeenCalledWith(cycleId, undefined);
    });

    it("GET /companies/:cid/research-cycles/:cycleId/hypotheses forwards status query param", async () => {
      const res = await request(app).get(
        `/companies/${companyId}/research-cycles/${cycleId}/hypotheses?status=validated`,
      );
      expect(res.status).toBe(200);
      expect(mockAutoresearch.listHypotheses).toHaveBeenCalledWith(cycleId, "validated");
    });

    it("POST /companies/:cid/research-cycles/:cycleId/hypotheses returns 201 with created hypothesis", async () => {
      const res = await request(app)
        .post(`/companies/${companyId}/research-cycles/${cycleId}/hypotheses`)
        .send({ statement: "Users prefer X" });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ id: "hyp-1", statement: "Users prefer X" });
      expect(mockAutoresearch.createHypothesis).toHaveBeenCalledWith(companyId, {
        statement: "Users prefer X",
        cycleId,
      });
    });

    it("PATCH /companies/:cid/hypotheses/:id returns 200 with updated hypothesis", async () => {
      const res = await request(app)
        .patch(`/companies/${companyId}/hypotheses/hyp-1`)
        .send({ status: "validated" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: "hyp-1", status: "validated" });
      expect(mockAutoresearch.updateHypothesis).toHaveBeenCalledWith("hyp-1", {
        status: "validated",
      });
    });
  });

  describe("experiments", () => {
    it("GET /companies/:cid/research-cycles/:cycleId/experiments returns 200 with list", async () => {
      const res = await request(app).get(
        `/companies/${companyId}/research-cycles/${cycleId}/experiments`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
      expect(mockAutoresearch.listExperiments).toHaveBeenCalledWith(cycleId, undefined);
    });

    it("GET /companies/:cid/research-cycles/:cycleId/experiments forwards status query param", async () => {
      const res = await request(app).get(
        `/companies/${companyId}/research-cycles/${cycleId}/experiments?status=running`,
      );
      expect(res.status).toBe(200);
      expect(mockAutoresearch.listExperiments).toHaveBeenCalledWith(cycleId, "running");
    });

    it("POST /companies/:cid/research-cycles/:cycleId/experiments returns 201 with created experiment", async () => {
      const res = await request(app)
        .post(`/companies/${companyId}/research-cycles/${cycleId}/experiments`)
        .send({ name: "A/B test" });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ id: "exp-1", name: "A/B test" });
      expect(mockAutoresearch.createExperiment).toHaveBeenCalledWith(companyId, {
        name: "A/B test",
        cycleId,
      });
    });

    it("GET /companies/:cid/experiments/:id returns 200 with experiment", async () => {
      const res = await request(app).get(`/companies/${companyId}/experiments/${experimentId}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: "exp-1", name: "A/B test" });
      expect(mockAutoresearch.getExperimentById).toHaveBeenCalledWith(experimentId);
    });

    it("PATCH /companies/:cid/experiments/:id returns 200 with updated experiment", async () => {
      const res = await request(app)
        .patch(`/companies/${companyId}/experiments/${experimentId}`)
        .send({ status: "running" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: "exp-1", status: "running" });
      expect(mockAutoresearch.updateExperiment).toHaveBeenCalledWith(experimentId, {
        status: "running",
      });
    });

    it("POST /companies/:cid/experiments/:id/abort returns 200 with aborted experiment", async () => {
      const res = await request(app)
        .post(`/companies/${companyId}/experiments/${experimentId}/abort`)
        .send({ reason: "Too slow" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: "exp-1", status: "aborted" });
      expect(mockAutoresearch.abortExperiment).toHaveBeenCalledWith(experimentId, "Too slow");
    });

    it("POST /companies/:cid/experiments/:id/abort uses default reason when none provided", async () => {
      const res = await request(app)
        .post(`/companies/${companyId}/experiments/${experimentId}/abort`)
        .send({});
      expect(res.status).toBe(200);
      expect(mockAutoresearch.abortExperiment).toHaveBeenCalledWith(experimentId, "Manual abort");
    });
  });

  describe("metric definitions", () => {
    it("GET /companies/:cid/metric-definitions returns 200 with list", async () => {
      const res = await request(app).get(`/companies/${companyId}/metric-definitions`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
      expect(mockAutoresearch.listMetricDefinitions).toHaveBeenCalledWith(companyId);
    });

    it("POST /companies/:cid/metric-definitions returns 201 with created metric definition", async () => {
      const res = await request(app)
        .post(`/companies/${companyId}/metric-definitions`)
        .send({ key: "conversion_rate" });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ id: "md-1", key: "conversion_rate" });
      expect(mockAutoresearch.createMetricDefinition).toHaveBeenCalledWith(companyId, {
        key: "conversion_rate",
      });
    });

    it("PATCH /companies/:cid/metric-definitions/:id returns 200 with updated metric definition", async () => {
      const res = await request(app)
        .patch(`/companies/${companyId}/metric-definitions/md-1`)
        .send({ key: "conversion_rate_v2" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: "md-1", key: "conversion_rate_v2" });
      expect(mockAutoresearch.updateMetricDefinition).toHaveBeenCalledWith("md-1", {
        key: "conversion_rate_v2",
      });
    });
  });

  describe("measurements", () => {
    it("GET /companies/:cid/experiments/:experimentId/measurements returns 200 with list", async () => {
      const res = await request(app).get(
        `/companies/${companyId}/experiments/${experimentId}/measurements`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
      expect(mockAutoresearch.listMeasurements).toHaveBeenCalledWith(experimentId);
    });

    it("POST /companies/:cid/experiments/:experimentId/measurements returns 201 with recorded measurement", async () => {
      const res = await request(app)
        .post(`/companies/${companyId}/experiments/${experimentId}/measurements`)
        .send({ value: 42 });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ id: "meas-1", value: 42 });
      expect(mockAutoresearch.recordMeasurement).toHaveBeenCalledWith(companyId, {
        value: 42,
        experimentId,
      });
    });

    it("GET /companies/:cid/metrics/:key/measurements returns 200 with time series", async () => {
      const res = await request(app).get(
        `/companies/${companyId}/metrics/conversion_rate/measurements`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ key: "conversion_rate", points: [] });
      expect(mockAutoresearch.getMetricTimeSeries).toHaveBeenCalledWith(
        companyId,
        "conversion_rate",
        { days: undefined },
      );
    });

    it("GET /companies/:cid/metrics/:key/measurements forwards days query param", async () => {
      const res = await request(app).get(
        `/companies/${companyId}/metrics/conversion_rate/measurements?days=30`,
      );
      expect(res.status).toBe(200);
      expect(mockAutoresearch.getMetricTimeSeries).toHaveBeenCalledWith(
        companyId,
        "conversion_rate",
        { days: 30 },
      );
    });
  });

  describe("evaluations", () => {
    it("GET /companies/:cid/research-cycles/:cycleId/evaluations returns 200 with list", async () => {
      const res = await request(app).get(
        `/companies/${companyId}/research-cycles/${cycleId}/evaluations`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
      expect(mockAutoresearch.listEvaluations).toHaveBeenCalledWith(cycleId);
    });

    it("POST /companies/:cid/experiments/:experimentId/evaluations returns 201 with created evaluation", async () => {
      const res = await request(app)
        .post(`/companies/${companyId}/experiments/${experimentId}/evaluations`)
        .send({ verdict: "significant" });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ id: "eval-1", verdict: "significant" });
      expect(mockAutoresearch.createEvaluation).toHaveBeenCalledWith(companyId, {
        verdict: "significant",
        experimentId,
      });
    });

    it("GET /companies/:cid/evaluations/:id returns 200 with evaluation", async () => {
      const res = await request(app).get(`/companies/${companyId}/evaluations/eval-1`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: "eval-1", verdict: "significant" });
      expect(mockAutoresearch.getEvaluationById).toHaveBeenCalledWith("eval-1");
    });
  });
});
