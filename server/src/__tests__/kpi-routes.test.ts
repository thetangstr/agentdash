import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { kpiRoutes } from "../routes/kpis.js";
import { errorHandler } from "../middleware/index.js";

// AgentDash: Manual KPIs route tests (AGE-45)

const mockKpisService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  findByName: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  setValue: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  kpisService: () => mockKpisService,
  logActivity: mockLogActivity,
}));

interface ActorOverride {
  companyIds?: string[];
  isInstanceAdmin?: boolean;
  source?: string;
}

function createApp(actor: ActorOverride = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "board-user",
      companyIds: actor.companyIds ?? ["company-1"],
      source: actor.source ?? "local_implicit",
      isInstanceAdmin: actor.isInstanceAdmin ?? false,
    };
    next();
  });
  app.use("/api", kpiRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("kpiRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("GET /companies/:companyId/kpis returns KPI list", async () => {
    const rows = [
      { id: "k1", companyId: "company-1", name: "MRR", unit: "USD" },
      { id: "k2", companyId: "company-1", name: "ARR", unit: "USD" },
    ];
    mockKpisService.list.mockResolvedValue(rows);
    const res = await request(createApp()).get("/api/companies/company-1/kpis");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(rows);
    expect(mockKpisService.list).toHaveBeenCalledWith("company-1");
  });

  it("POST creates KPI and logs activity", async () => {
    const created = {
      id: "k-new",
      companyId: "company-1",
      name: "NPS",
      unit: "",
      targetValue: "50",
      currentValue: null,
      priority: 0,
    };
    mockKpisService.create.mockResolvedValue(created);
    const res = await request(createApp())
      .post("/api/companies/company-1/kpis")
      .send({ name: "NPS", targetValue: 50 });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockKpisService.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ name: "NPS", targetValue: 50 }),
    );
    expect(mockLogActivity).toHaveBeenCalled();
  });

  it("POST rejects missing name via validator", async () => {
    const res = await request(createApp())
      .post("/api/companies/company-1/kpis")
      .send({ targetValue: 100 });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("PATCH updates KPI when in company scope", async () => {
    mockKpisService.getById.mockResolvedValue({
      id: "k1",
      companyId: "company-1",
      name: "MRR",
    });
    mockKpisService.update.mockResolvedValue({ id: "k1", name: "MRR v2" });
    const res = await request(createApp())
      .patch("/api/companies/company-1/kpis/k1")
      .send({ name: "MRR v2" });
    expect(res.status).toBe(200);
    expect(mockKpisService.update).toHaveBeenCalledWith("k1", expect.objectContaining({ name: "MRR v2" }));
  });

  it("PATCH returns 404 when KPI belongs to another company", async () => {
    mockKpisService.getById.mockResolvedValue({
      id: "k1",
      companyId: "company-OTHER",
      name: "X",
    });
    const res = await request(createApp())
      .patch("/api/companies/company-1/kpis/k1")
      .send({ name: "hack" });
    expect(res.status).toBe(404);
  });

  it("DELETE removes KPI and logs activity", async () => {
    mockKpisService.getById.mockResolvedValue({
      id: "k1",
      companyId: "company-1",
      name: "MRR",
    });
    mockKpisService.remove.mockResolvedValue({ id: "k1" });
    const res = await request(createApp()).delete("/api/companies/company-1/kpis/k1");
    expect(res.status).toBe(200);
    expect(mockKpisService.remove).toHaveBeenCalledWith("k1");
    expect(mockLogActivity).toHaveBeenCalled();
  });

  it("POST /value updates the current value", async () => {
    mockKpisService.getById.mockResolvedValue({
      id: "k1",
      companyId: "company-1",
      name: "MRR",
    });
    mockKpisService.setValue.mockResolvedValue({ id: "k1", currentValue: "1234" });
    const res = await request(createApp())
      .post("/api/companies/company-1/kpis/k1/value")
      .send({ value: 1234 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockKpisService.setValue).toHaveBeenCalledWith("k1", 1234);
  });

  it("POST /value rejects value for KPI in another company", async () => {
    mockKpisService.getById.mockResolvedValue({
      id: "k1",
      companyId: "company-OTHER",
      name: "X",
    });
    const res = await request(createApp())
      .post("/api/companies/company-1/kpis/k1/value")
      .send({ value: 1 });
    expect(res.status).toBe(404);
    expect(mockKpisService.setValue).not.toHaveBeenCalled();
  });

  it("GET rejects cross-company access for non-admin jwt user", async () => {
    const res = await request(
      createApp({ companyIds: ["other-co"], source: "jwt", isInstanceAdmin: false }),
    ).get("/api/companies/company-1/kpis");
    expect(res.status).toBe(403);
  });
});
