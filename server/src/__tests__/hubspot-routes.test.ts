import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hubspotRoutes } from "../routes/hubspot.js";
import { errorHandler } from "../middleware/index.js";

const mockHubspot = vi.hoisted(() => ({
  getConfig: vi.fn(async () => null),
  setConfig: vi.fn(async () => undefined),
  testConnection: vi.fn(async () => ({ connected: true, portalId: "12345" })),
  getSyncStatus: vi.fn(async () => ({ lastSync: "2026-01-01", status: "idle" })),
  syncAll: vi.fn(async () => ({ synced: true, counts: { contacts: 10, companies: 5 } })),
  findCompanyByPortalId: vi.fn(async () => null),
  verifyWebhookSignature: vi.fn(() => true),
  handleWebhook: vi.fn(async () => undefined),
}));

vi.mock("../services/hubspot.js", () => ({
  hubspotService: () => mockHubspot,
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
  app.use("/api", hubspotRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const app = createApp();

describe("hubspot routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHubspot.getConfig.mockResolvedValue(null);
    mockHubspot.setConfig.mockResolvedValue(undefined);
    mockHubspot.testConnection.mockResolvedValue({ connected: true, portalId: "12345" });
    mockHubspot.getSyncStatus.mockResolvedValue({ lastSync: "2026-01-01", status: "idle" });
    mockHubspot.syncAll.mockResolvedValue({ synced: true, counts: { contacts: 10, companies: 5 } });
    mockHubspot.findCompanyByPortalId.mockResolvedValue(null);
    mockHubspot.verifyWebhookSignature.mockReturnValue(true);
    mockHubspot.handleWebhook.mockResolvedValue(undefined);
  });

  describe("config", () => {
    it("POST /config saves configuration and returns success", async () => {
      const res = await request(app)
        .post("/api/companies/company-1/integrations/hubspot/config")
        .send({ portalId: "12345", accessToken: "pat-abc", syncEnabled: true });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(mockHubspot.setConfig).toHaveBeenCalledWith(
        "company-1",
        { portalId: "12345", accessToken: "pat-abc", syncEnabled: true },
      );
    });

    it("GET /config returns { configured: false } when no config exists", async () => {
      const res = await request(app).get("/api/companies/company-1/integrations/hubspot/config");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ configured: false });
    });

    it("GET /config returns redacted token when config is set", async () => {
      mockHubspot.getConfig.mockResolvedValue({
        portalId: "12345",
        syncEnabled: true,
        accessToken: "pat-12345678",
        clientSecret: "secret",
      });

      const res = await request(app).get("/api/companies/company-1/integrations/hubspot/config");

      expect(res.status).toBe(200);
      expect(res.body.configured).toBe(true);
      expect(res.body.portalId).toBe("12345");
      expect(res.body.syncEnabled).toBe(true);
      expect(res.body.accessToken).toBe("****5678");
      expect(res.body.hasClientSecret).toBe(true);
    });
  });

  describe("connection test", () => {
    it("POST /test returns connection result", async () => {
      const res = await request(app)
        .post("/api/companies/company-1/integrations/hubspot/test")
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ connected: true, portalId: "12345" });
      expect(mockHubspot.testConnection).toHaveBeenCalledWith("company-1");
    });
  });

  describe("sync", () => {
    it("GET /sync/status returns sync status", async () => {
      const res = await request(app).get(
        "/api/companies/company-1/integrations/hubspot/sync/status",
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ lastSync: "2026-01-01", status: "idle" });
      expect(mockHubspot.getSyncStatus).toHaveBeenCalledWith("company-1");
    });

    it("POST /sync triggers full sync and returns result", async () => {
      const res = await request(app)
        .post("/api/companies/company-1/integrations/hubspot/sync")
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ synced: true, counts: { contacts: 10, companies: 5 } });
      expect(mockHubspot.syncAll).toHaveBeenCalledWith("company-1");
    });
  });

  describe("webhook", () => {
    it("POST /webhooks/hubspot with no companyId and no portalId match returns warning", async () => {
      const res = await request(app)
        .post("/api/webhooks/hubspot")
        .send([{ eventType: "contact.creation" }]);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true, warning: "Could not resolve company" });
      expect(mockHubspot.handleWebhook).not.toHaveBeenCalled();
    });

    it("POST /webhooks/hubspot?companyId=company-1 processes webhook when companyId provided", async () => {
      const res = await request(app)
        .post("/api/webhooks/hubspot?companyId=company-1")
        .send([{ eventType: "contact.creation" }]);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
      expect(mockHubspot.handleWebhook).toHaveBeenCalledWith(
        "company-1",
        [{ eventType: "contact.creation" }],
      );
    });

    it("POST /webhooks/hubspot with portalId in body calls findCompanyByPortalId", async () => {
      const res = await request(app)
        .post("/api/webhooks/hubspot")
        .send([{ portalId: 99999, eventType: "contact.creation" }]);

      expect(mockHubspot.findCompanyByPortalId).toHaveBeenCalledWith("99999");
      // findCompanyByPortalId returns null, so company cannot be resolved
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true, warning: "Could not resolve company" });
    });

    it("POST /webhooks/hubspot skips signature check when config has no clientSecret", async () => {
      // getConfig returns null, so no signature verification should occur
      const res = await request(app)
        .post("/api/webhooks/hubspot?companyId=company-1")
        .send({ eventType: "contact.creation" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ received: true });
      expect(mockHubspot.verifyWebhookSignature).not.toHaveBeenCalled();
    });
  });
});
