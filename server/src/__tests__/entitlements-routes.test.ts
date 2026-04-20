import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { entitlementsRoutes } from "../routes/entitlements.js";
import { errorHandler } from "../middleware/index.js";

const mockEntitlements = vi.hoisted(() => ({
  getTier: vi.fn(async () => "pro" as const),
  setTier: vi.fn(async () => undefined),
  getEntitlements: vi.fn(async () => ({
    tier: "pro" as const,
    limits: { agents: 25, monthlyActions: 50_000, pipelines: 10 },
    features: {
      hubspotSync: true,
      autoResearch: true,
      assessMode: true,
      prioritySupport: false,
    },
  })),
}));

vi.mock("../services/entitlements.js", () => ({
  entitlementsService: () => mockEntitlements,
}));

let actorIsAdmin = false;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: actorIsAdmin,
    };
    next();
  });
  app.use("/api", entitlementsRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const app = createApp();

describe("entitlements routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    actorIsAdmin = false;
    mockEntitlements.getTier.mockResolvedValue("pro");
    mockEntitlements.setTier.mockResolvedValue(undefined);
    mockEntitlements.getEntitlements.mockResolvedValue({
      tier: "pro",
      limits: { agents: 25, monthlyActions: 50_000, pipelines: 10 },
      features: {
        hubspotSync: true,
        autoResearch: true,
        assessMode: true,
        prioritySupport: false,
      },
    });
  });

  describe("GET /companies/:companyId/entitlements", () => {
    it("returns the materialized entitlements object", async () => {
      const res = await request(app).get("/api/companies/company-1/entitlements");
      expect(res.status).toBe(200);
      expect(res.body.tier).toBe("pro");
      expect(res.body.features.hubspotSync).toBe(true);
      expect(mockEntitlements.getEntitlements).toHaveBeenCalledWith("company-1");
    });

    it("forwards the companyId from the URL path to the service", async () => {
      await request(app).get("/api/companies/company-1/entitlements");
      expect(mockEntitlements.getEntitlements).toHaveBeenCalledWith("company-1");
    });
  });

  describe("PATCH /companies/:companyId/entitlements", () => {
    it("rejects non-admin requests with 403", async () => {
      actorIsAdmin = false;
      const res = await request(app)
        .patch("/api/companies/company-1/entitlements")
        .send({ tier: "enterprise" });
      expect(res.status).toBe(403);
      expect(mockEntitlements.setTier).not.toHaveBeenCalled();
    });

    it("rejects invalid tier values with 400", async () => {
      actorIsAdmin = true;
      const res = await request(app)
        .patch("/api/companies/company-1/entitlements")
        .send({ tier: "platinum" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_tier");
      expect(mockEntitlements.setTier).not.toHaveBeenCalled();
    });

    it("sets tier and returns fresh entitlements on valid admin request", async () => {
      actorIsAdmin = true;
      mockEntitlements.getEntitlements.mockResolvedValueOnce({
        tier: "enterprise",
        limits: { agents: 1000, monthlyActions: 5_000_000, pipelines: 1000 },
        features: {
          hubspotSync: true,
          autoResearch: true,
          assessMode: true,
          prioritySupport: true,
        },
      });
      const res = await request(app)
        .patch("/api/companies/company-1/entitlements")
        .send({ tier: "enterprise" });
      expect(res.status).toBe(200);
      expect(res.body.tier).toBe("enterprise");
      expect(res.body.features.prioritySupport).toBe(true);
      expect(mockEntitlements.setTier).toHaveBeenCalledWith("company-1", "enterprise");
    });
  });
});
