import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

// Mock the quota service so we don't need a real DB
vi.mock("../services/quota.js", () => ({
  quotaService: vi.fn(),
}));

import { quotaService } from "../services/quota.js";
import { quotaRoutes } from "../routes/quota.js";

function createApp(mockGetQuota: any) {
  vi.mocked(quotaService).mockReturnValue({
    getQuota: mockGetQuota,
  });

  const app = express();
  app.use(express.json());

  // Inject actor middleware
  app.use((req: any, _res: any, next: any) => {
    req.actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["co-1"],
      source: "session",
    };
    next();
  });

  app.use("/api", quotaRoutes({} as any));

  // Error handler
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });

  return app;
}

describe("GET /api/companies/:companyId/quota", () => {
  it("returns quota snapshot for a free workspace", async () => {
    const snapshot = {
      tier: "free",
      includedRuns: 50,
      usedRuns: 12,
      remainingRuns: 38,
      overageRuns: 0,
      seatsCount: 0,
      billingPeriodStart: "2026-06-01T00:00:00.000Z",
      billingPeriodEnd: "2026-07-01T00:00:00.000Z",
    };
    const app = createApp(vi.fn().mockResolvedValue(snapshot));

    const res = await request(app).get("/api/companies/co-1/quota");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(snapshot);
  });

  it("returns quota snapshot for a pro workspace with seats", async () => {
    const snapshot = {
      tier: "pro_active",
      includedRuns: 2000,
      usedRuns: 500,
      remainingRuns: 1500,
      overageRuns: 0,
      seatsCount: 4,
      billingPeriodStart: "2026-05-15T00:00:00.000Z",
      billingPeriodEnd: "2026-06-15T00:00:00.000Z",
    };
    const app = createApp(vi.fn().mockResolvedValue(snapshot));

    const res = await request(app).get("/api/companies/co-1/quota");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(snapshot);
  });

  it("returns 403 when actor is not in company", async () => {
    const app = createApp(vi.fn());

    const res = await request(app).get("/api/companies/co-other/quota");

    expect(res.status).toBe(403);
  });

  it("returns 404 when company not found", async () => {
    const app = createApp(vi.fn().mockResolvedValue(null));

    const res = await request(app).get("/api/companies/co-1/quota");

    expect(res.status).toBe(404);
  });
});
