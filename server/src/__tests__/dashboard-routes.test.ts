import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardRoutes } from "../routes/dashboard.js";
import { errorHandler } from "../middleware/index.js";

const mockDashboard = vi.hoisted(() => ({
  summary: vi.fn(),
}));

vi.mock("../services/dashboard.js", () => ({
  dashboardService: () => mockDashboard,
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
  app.use("/api", dashboardRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("dashboard routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDashboard.summary.mockResolvedValue({
      agents: { total: 5, active: 3 },
      issues: { open: 10 },
      costs: { monthSpendCents: 5000 },
    });
  });

  it("returns 200 with summary object", async () => {
    const res = await request(createApp())
      .get("/api/companies/company-1/dashboard");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      agents: { total: 5, active: 3 },
      issues: { open: 10 },
      costs: { monthSpendCents: 5000 },
    });
  });

  it("calls summary with the companyId from the route param", async () => {
    await request(createApp())
      .get("/api/companies/company-1/dashboard");

    expect(mockDashboard.summary).toHaveBeenCalledOnce();
    expect(mockDashboard.summary).toHaveBeenCalledWith("company-1");
  });
});
