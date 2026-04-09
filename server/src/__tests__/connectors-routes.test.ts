import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectorRoutes } from "../routes/connectors.js";
import { errorHandler } from "../middleware/index.js";

const companyId = "company-1";

const mockConnectors = vi.hoisted(() => ({
  list: vi.fn(async () => [{ id: "conn-1", provider: "hubspot", status: "connected" }]),
  disconnect: vi.fn(async () => ({ id: "conn-1", status: "disconnected" })),
}));

vi.mock("../services/connectors.js", () => ({
  connectorService: () => mockConnectors,
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
  app.use("/api", connectorRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("connector routes", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  describe("GET /companies/:cid/connectors", () => {
    it("returns 200 with connector list", async () => {
      const res = await request(app).get(`/api/companies/${companyId}/connectors`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([{ id: "conn-1", provider: "hubspot", status: "connected" }]);
      expect(mockConnectors.list).toHaveBeenCalledWith(companyId);
    });
  });

  describe("POST /companies/:cid/connectors/:provider/connect", () => {
    it("returns 200 with not_configured status for hubspot", async () => {
      const res = await request(app).post(`/api/companies/${companyId}/connectors/hubspot/connect`);

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("not_configured");
      expect(res.body.provider).toBe("hubspot");
    });

    it("returns 422 for an unsupported provider", async () => {
      const res = await request(app).post(`/api/companies/${companyId}/connectors/unknown_provider/connect`);

      expect(res.status).toBe(422);
    });
  });

  describe("GET /companies/:cid/connectors/:provider/callback", () => {
    it("returns 200 with callback_received status when code is provided", async () => {
      const res = await request(app)
        .get(`/api/companies/${companyId}/connectors/hubspot/callback`)
        .query({ code: "abc123" });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("callback_received");
      expect(res.body.provider).toBe("hubspot");
    });

    it("returns 400 when code param is missing", async () => {
      const res = await request(app).get(`/api/companies/${companyId}/connectors/hubspot/callback`);

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/missing authorization code/i);
    });
  });

  describe("DELETE /companies/:cid/connectors/:connectorId", () => {
    it("returns 200 with disconnected result", async () => {
      const res = await request(app).delete(`/api/companies/${companyId}/connectors/conn-1`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id: "conn-1", status: "disconnected" });
      expect(mockConnectors.disconnect).toHaveBeenCalledWith(companyId, "conn-1");
    });
  });
});
