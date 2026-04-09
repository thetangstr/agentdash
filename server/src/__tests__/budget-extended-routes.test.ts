import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { budgetExtendedRoutes } from "../routes/budget-extended.js";
import { errorHandler } from "../middleware/index.js";

const companyId = "company-1";
const deptId = "dept-1";
const allocId = "alloc-1";
const projectId = "project-1";
const agentId = "agent-1";

const mockForecast = vi.hoisted(() => ({
  listDepartments: vi.fn(async () => [{ id: "dept-1", name: "Engineering" }]),
  createDepartment: vi.fn(async () => ({ id: "dept-1", name: "Engineering" })),
  updateDepartment: vi.fn(async () => ({ id: "dept-1", name: "Engineering v2" })),
  createAllocation: vi.fn(async () => ({ id: "alloc-1", allocatedAmount: 5000 })),
  listAllocations: vi.fn(async () => [{ id: "alloc-1" }]),
  computeBurnRate: vi.fn(async () => ({ dailyRate: 100, projectedTotal: 3000 })),
  computeProjectROI: vi.fn(async () => ({ roi: 2.5, totalSpend: 10000, totalValue: 25000 })),
  recordResourceUsage: vi.fn(async () => ({ id: "usage-1" })),
  getResourceUsageSummary: vi.fn(async () => ({ totalTokens: 50000, totalCostCents: 1500 })),
}));

const mockCapacity = vi.hoisted(() => ({
  getWorkforceSnapshot: vi.fn(async () => ({ totalAgents: 5, activeAgents: 3 })),
  getTaskPipeline: vi.fn(async () => ({ backlog: 10, inProgress: 5, done: 20 })),
  estimateProjectCapacity: vi.fn(async () => ({ estimatedDays: 14, agentsNeeded: 3 })),
  getAgentThroughput: vi.fn(async () => ({ issuesPerDay: 2.5, avgCycleTimeHours: 8 })),
  recommendSpawns: vi.fn(async () => [{ role: "engineer", count: 2 }]),
}));

vi.mock("../services/budget-forecasts.js", () => ({
  budgetForecastService: () => mockForecast,
}));

vi.mock("../services/capacity-planning.js", () => ({
  capacityPlanningService: () => mockCapacity,
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
  app.use("/api", budgetExtendedRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("budget extended routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockForecast.listDepartments.mockResolvedValue([{ id: "dept-1", name: "Engineering" }]);
    mockForecast.createDepartment.mockResolvedValue({ id: "dept-1", name: "Engineering" });
    mockForecast.updateDepartment.mockResolvedValue({ id: "dept-1", name: "Engineering v2" });
    mockForecast.createAllocation.mockResolvedValue({ id: "alloc-1", allocatedAmount: 5000 });
    mockForecast.listAllocations.mockResolvedValue([{ id: "alloc-1" }]);
    mockForecast.computeBurnRate.mockResolvedValue({ dailyRate: 100, projectedTotal: 3000 });
    mockForecast.computeProjectROI.mockResolvedValue({ roi: 2.5, totalSpend: 10000, totalValue: 25000 });
    mockForecast.recordResourceUsage.mockResolvedValue({ id: "usage-1" });
    mockForecast.getResourceUsageSummary.mockResolvedValue({ totalTokens: 50000, totalCostCents: 1500 });
    mockCapacity.getWorkforceSnapshot.mockResolvedValue({ totalAgents: 5, activeAgents: 3 });
    mockCapacity.getTaskPipeline.mockResolvedValue({ backlog: 10, inProgress: 5, done: 20 });
    mockCapacity.estimateProjectCapacity.mockResolvedValue({ estimatedDays: 14, agentsNeeded: 3 });
    mockCapacity.getAgentThroughput.mockResolvedValue({ issuesPerDay: 2.5, avgCycleTimeHours: 8 });
    mockCapacity.recommendSpawns.mockResolvedValue([{ role: "engineer", count: 2 }]);
  });

  describe("departments", () => {
    it("GET /companies/:cid/departments returns 200 with department list", async () => {
      const app = createApp();
      const res = await request(app).get(`/api/companies/${companyId}/departments`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ id: "dept-1", name: "Engineering" }]);
      expect(mockForecast.listDepartments).toHaveBeenCalledWith(companyId);
    });

    it("POST /companies/:cid/departments returns 201 with created department", async () => {
      const app = createApp();
      const res = await request(app)
        .post(`/api/companies/${companyId}/departments`)
        .send({ name: "Engineering", description: null });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ id: "dept-1", name: "Engineering" });
      expect(mockForecast.createDepartment).toHaveBeenCalledWith(
        companyId,
        expect.objectContaining({ name: "Engineering" }),
      );
    });

    it("PATCH /companies/:cid/departments/:id returns 200 with updated department", async () => {
      const app = createApp();
      const res = await request(app)
        .patch(`/api/companies/${companyId}/departments/${deptId}`)
        .send({ name: "Engineering v2" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: "dept-1", name: "Engineering v2" });
      expect(mockForecast.updateDepartment).toHaveBeenCalledWith(deptId, expect.objectContaining({ name: "Engineering v2" }));
    });
  });

  describe("allocations", () => {
    it("POST /companies/:cid/budget-allocations returns 201 with created allocation", async () => {
      const app = createApp();
      const res = await request(app)
        .post(`/api/companies/${companyId}/budget-allocations`)
        .send({ parentPolicyId: "p1", childPolicyId: "c1", allocatedAmount: 5000, isFlexible: false });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ id: "alloc-1", allocatedAmount: 5000 });
      expect(mockForecast.createAllocation).toHaveBeenCalledWith(
        companyId,
        expect.objectContaining({ allocatedAmount: 5000 }),
      );
    });

    it("GET /companies/:cid/budget-allocations returns 200 with allocation list", async () => {
      const app = createApp();
      const res = await request(app).get(`/api/companies/${companyId}/budget-allocations`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ id: "alloc-1" }]);
      expect(mockForecast.listAllocations).toHaveBeenCalledWith(companyId, undefined);
    });

    it("GET /companies/:cid/budget-allocations passes parentPolicyId query param", async () => {
      const app = createApp();
      const res = await request(app)
        .get(`/api/companies/${companyId}/budget-allocations`)
        .query({ parentPolicyId: "p1" });
      expect(res.status).toBe(200);
      expect(mockForecast.listAllocations).toHaveBeenCalledWith(companyId, "p1");
    });
  });

  describe("forecasts", () => {
    it("GET /companies/:cid/budget-forecasts/burn-rate returns 200 with burn rate", async () => {
      const app = createApp();
      const res = await request(app)
        .get(`/api/companies/${companyId}/budget-forecasts/burn-rate`)
        .query({ scopeType: "agent", scopeId: "agent-1" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ dailyRate: 100, projectedTotal: 3000 });
      expect(mockForecast.computeBurnRate).toHaveBeenCalledWith(companyId, "agent", "agent-1");
    });

    it("GET /companies/:cid/budget-forecasts/roi/:projectId returns 200 with ROI", async () => {
      const app = createApp();
      const res = await request(app).get(`/api/companies/${companyId}/budget-forecasts/roi/${projectId}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ roi: 2.5, totalSpend: 10000, totalValue: 25000 });
      expect(mockForecast.computeProjectROI).toHaveBeenCalledWith(companyId, projectId);
    });
  });

  describe("resource usage", () => {
    it("POST /companies/:cid/resource-usage returns 201 with recorded usage", async () => {
      const app = createApp();
      const occurredAt = "2026-04-01T00:00:00.000Z";
      const res = await request(app)
        .post(`/api/companies/${companyId}/resource-usage`)
        .send({ agentId: "agent-1", resourceType: "tokens", amount: 1000, occurredAt });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ id: "usage-1" });
      expect(mockForecast.recordResourceUsage).toHaveBeenCalledWith(
        companyId,
        expect.objectContaining({ occurredAt: expect.any(Date) }),
      );
    });

    it("GET /companies/:cid/resource-usage/summary returns 200 with summary", async () => {
      const app = createApp();
      const res = await request(app).get(`/api/companies/${companyId}/resource-usage/summary`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ totalTokens: 50000, totalCostCents: 1500 });
      expect(mockForecast.getResourceUsageSummary).toHaveBeenCalledWith(companyId, {
        resourceType: undefined,
        agentId: undefined,
        days: undefined,
      });
    });

    it("GET /companies/:cid/resource-usage/summary passes query filters", async () => {
      const app = createApp();
      const res = await request(app)
        .get(`/api/companies/${companyId}/resource-usage/summary`)
        .query({ resourceType: "tokens", agentId: "agent-1", days: "7" });
      expect(res.status).toBe(200);
      expect(mockForecast.getResourceUsageSummary).toHaveBeenCalledWith(companyId, {
        resourceType: "tokens",
        agentId: "agent-1",
        days: 7,
      });
    });
  });

  describe("capacity planning", () => {
    it("GET /companies/:cid/capacity/workforce returns 200 with workforce snapshot", async () => {
      const app = createApp();
      const res = await request(app).get(`/api/companies/${companyId}/capacity/workforce`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ totalAgents: 5, activeAgents: 3 });
      expect(mockCapacity.getWorkforceSnapshot).toHaveBeenCalledWith(companyId);
    });

    it("GET /companies/:cid/capacity/pipeline returns 200 with task pipeline", async () => {
      const app = createApp();
      const res = await request(app).get(`/api/companies/${companyId}/capacity/pipeline`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ backlog: 10, inProgress: 5, done: 20 });
      expect(mockCapacity.getTaskPipeline).toHaveBeenCalledWith(companyId, undefined);
    });

    it("GET /companies/:cid/capacity/pipeline passes projectId query param", async () => {
      const app = createApp();
      const res = await request(app)
        .get(`/api/companies/${companyId}/capacity/pipeline`)
        .query({ projectId: "proj-1" });
      expect(res.status).toBe(200);
      expect(mockCapacity.getTaskPipeline).toHaveBeenCalledWith(companyId, "proj-1");
    });

    it("GET /companies/:cid/capacity/estimate/:projectId returns 200 with capacity estimate", async () => {
      const app = createApp();
      const res = await request(app).get(`/api/companies/${companyId}/capacity/estimate/${projectId}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ estimatedDays: 14, agentsNeeded: 3 });
      expect(mockCapacity.estimateProjectCapacity).toHaveBeenCalledWith(projectId);
    });

    it("GET /companies/:cid/capacity/recommendations/:projectId returns 200 with spawn recommendations", async () => {
      const app = createApp();
      const res = await request(app).get(`/api/companies/${companyId}/capacity/recommendations/${projectId}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ role: "engineer", count: 2 }]);
      expect(mockCapacity.recommendSpawns).toHaveBeenCalledWith(companyId, projectId);
    });

    it("GET /agents/:agentId/throughput returns 200 with agent throughput", async () => {
      const app = createApp();
      const res = await request(app).get(`/api/agents/${agentId}/throughput`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ issuesPerDay: 2.5, avgCycleTimeHours: 8 });
      expect(mockCapacity.getAgentThroughput).toHaveBeenCalledWith(agentId, undefined);
    });

    it("GET /agents/:agentId/throughput passes windowDays query param", async () => {
      const app = createApp();
      const res = await request(app)
        .get(`/api/agents/${agentId}/throughput`)
        .query({ windowDays: "14" });
      expect(res.status).toBe(200);
      expect(mockCapacity.getAgentThroughput).toHaveBeenCalledWith(agentId, 14);
    });
  });
});
