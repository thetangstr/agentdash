import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock security service ────────────────────────────────────────────────

const mockSecurity = vi.hoisted(() => ({
  createPolicy: vi.fn(async () => ({
    id: "pol-1",
    name: "No prod deploys",
    policyType: "action_limit",
    isActive: true,
  })),
  listPolicies: vi.fn(async () => []),
  getPolicyById: vi.fn(async () => null),
  updatePolicy: vi.fn(async () => null),
  deactivatePolicy: vi.fn(async () => null),
  listPolicyEvaluations: vi.fn(async () => []),
  configureSandbox: vi.fn(async () => ({ id: "sb-1", agentId: "agent-1" })),
  getSandbox: vi.fn(async () => null),
  activateKillSwitch: vi.fn(async () => ({ id: "ks-1", action: "halt" })),
  resumeFromKillSwitch: vi.fn(async () => ({ id: "ks-2", action: "resume" })),
  getKillSwitchStatus: vi.fn(async () => ({ active: false })),
}));

vi.mock("../services/policy-engine.js", () => ({
  policyEngineService: () => mockSecurity,
}));

import express from "express";
import request from "supertest";
import { securityRoutes } from "../routes/security.js";
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
  app.use("/api", securityRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("Security routes", () => {
  let app: express.Express;

  beforeEach(() => {
    // Reset call history without clearing implementations set via vi.fn(async () => ...)
    Object.values(mockSecurity).forEach((fn) => (fn as ReturnType<typeof vi.fn>).mockClear());
    app = createApp();
  });

  // ── Policy CRUD ──────────────────────────────────────────────────────

  describe("policy CRUD", () => {
    it("POST /companies/:cid/security-policies creates a policy (201)", async () => {
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
      expect(res.body.name).toBe("No prod deploys");
      expect(res.body.policyType).toBe("action_limit");
      expect(res.body.isActive).toBe(true);
      expect(mockSecurity.createPolicy).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ name: "No prod deploys" }),
      );
    });

    it("GET /companies/:cid/security-policies returns empty array by default (200)", async () => {
      const res = await request(app)
        .get("/api/companies/company-1/security-policies")
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(0);
    });

    it("GET /companies/:cid/security-policies lists policies (200)", async () => {
      mockSecurity.listPolicies.mockResolvedValue([
        { id: "pol-1", name: "No prod deploys", policyType: "action_limit", isActive: true },
        { id: "pol-2", name: "Rate limit", policyType: "rate_limit", isActive: false },
      ]);

      const res = await request(app)
        .get("/api/companies/company-1/security-policies")
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(2);
      expect(mockSecurity.listPolicies).toHaveBeenCalledWith(
        "company-1",
        expect.any(Object),
      );
    });

    it("GET /companies/:cid/security-policies forwards query filters", async () => {
      await request(app)
        .get("/api/companies/company-1/security-policies?policyType=action_limit&isActive=true")
        .expect(200);

      expect(mockSecurity.listPolicies).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ policyType: "action_limit", isActive: true }),
      );
    });

    it("GET /companies/:cid/security-policies/:id returns 404 when not found", async () => {
      const res = await request(app)
        .get("/api/companies/company-1/security-policies/nonexistent")
        .expect(404);

      expect(res.body.error).toBeDefined();
    });

    it("GET /companies/:cid/security-policies/:id returns policy when found (200)", async () => {
      mockSecurity.getPolicyById.mockResolvedValue({
        id: "pol-1",
        name: "No prod deploys",
        policyType: "action_limit",
        isActive: true,
      });

      const res = await request(app)
        .get("/api/companies/company-1/security-policies/pol-1")
        .expect(200);

      expect(res.body.id).toBe("pol-1");
      expect(res.body.name).toBe("No prod deploys");
      expect(mockSecurity.getPolicyById).toHaveBeenCalledWith("pol-1");
    });

    it("PATCH /companies/:cid/security-policies/:id returns 404 when not found", async () => {
      const res = await request(app)
        .patch("/api/companies/company-1/security-policies/nonexistent")
        .send({ isActive: false })
        .expect(404);

      expect(res.body.error).toBeDefined();
    });

    it("PATCH /companies/:cid/security-policies/:id updates policy when found (200)", async () => {
      mockSecurity.updatePolicy.mockImplementation(async () => ({
        id: "pol-1",
        name: "No prod deploys",
        policyType: "action_limit",
        isActive: false,
      }));

      const res = await request(app)
        .patch("/api/companies/company-1/security-policies/pol-1")
        .send({ isActive: false })
        .expect(200);

      expect(res.body.id).toBe("pol-1");
      expect(res.body.isActive).toBe(false);
      expect(mockSecurity.updatePolicy).toHaveBeenCalledWith(
        "pol-1",
        expect.objectContaining({ isActive: false }),
      );
    });

    it("POST /companies/:cid/security-policies/:id/deactivate returns 404 when not found", async () => {
      const res = await request(app)
        .post("/api/companies/company-1/security-policies/nonexistent/deactivate")
        .expect(404);

      expect(res.body.error).toBeDefined();
    });

    it("POST /companies/:cid/security-policies/:id/deactivate deactivates policy when found (200)", async () => {
      mockSecurity.deactivatePolicy.mockResolvedValue({
        id: "pol-1",
        name: "No prod deploys",
        policyType: "action_limit",
        isActive: false,
      });

      const res = await request(app)
        .post("/api/companies/company-1/security-policies/pol-1/deactivate")
        .expect(200);

      expect(res.body.id).toBe("pol-1");
      expect(res.body.isActive).toBe(false);
      expect(mockSecurity.deactivatePolicy).toHaveBeenCalledWith("pol-1");
    });
  });

  // ── Policy Evaluations ───────────────────────────────────────────────

  describe("policy evaluations", () => {
    it("GET /companies/:cid/policy-evaluations returns empty array by default (200)", async () => {
      const res = await request(app)
        .get("/api/companies/company-1/policy-evaluations")
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(0);
    });

    it("GET /companies/:cid/policy-evaluations lists evaluations (200)", async () => {
      mockSecurity.listPolicyEvaluations.mockResolvedValue([
        { id: "eval-1", policyId: "pol-1", decision: "deny", agentId: "agent-1" },
        { id: "eval-2", policyId: "pol-1", decision: "allow", agentId: "agent-2" },
      ]);

      const res = await request(app)
        .get("/api/companies/company-1/policy-evaluations")
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(2);
      expect(mockSecurity.listPolicyEvaluations).toHaveBeenCalledWith(
        "company-1",
        expect.any(Object),
      );
    });

    it("GET /companies/:cid/policy-evaluations forwards query filters", async () => {
      await request(app)
        .get("/api/companies/company-1/policy-evaluations?agentId=agent-1&decision=deny&limit=10")
        .expect(200);

      expect(mockSecurity.listPolicyEvaluations).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ agentId: "agent-1", decision: "deny", limit: 10 }),
      );
    });
  });

  // ── Sandbox ──────────────────────────────────────────────────────────

  describe("sandbox", () => {
    it("POST /companies/:cid/agents/:agentId/sandbox configures sandbox (200)", async () => {
      const res = await request(app)
        .post("/api/companies/company-1/agents/agent-1/sandbox")
        .send({ networkPolicy: "isolated", allowedDomains: ["api.example.com"] })
        .expect(200);

      expect(res.body.id).toBe("sb-1");
      expect(res.body.agentId).toBe("agent-1");
      expect(mockSecurity.configureSandbox).toHaveBeenCalledWith(
        "company-1",
        "agent-1",
        expect.objectContaining({ networkPolicy: "isolated" }),
      );
    });

    it("GET /companies/:cid/agents/:agentId/sandbox returns 404 when not found", async () => {
      const res = await request(app)
        .get("/api/companies/company-1/agents/agent-1/sandbox")
        .expect(404);

      expect(res.body.error).toBeDefined();
    });

    it("GET /companies/:cid/agents/:agentId/sandbox returns sandbox when found (200)", async () => {
      mockSecurity.getSandbox.mockResolvedValue({
        id: "sb-1",
        agentId: "agent-1",
        networkPolicy: "isolated",
      });

      const res = await request(app)
        .get("/api/companies/company-1/agents/agent-1/sandbox")
        .expect(200);

      expect(res.body.id).toBe("sb-1");
      expect(res.body.agentId).toBe("agent-1");
      expect(mockSecurity.getSandbox).toHaveBeenCalledWith("company-1", "agent-1");
    });
  });

  // ── Kill Switch ──────────────────────────────────────────────────────

  describe("kill switch", () => {
    it("POST /companies/:cid/kill-switch activates kill switch (201)", async () => {
      const res = await request(app)
        .post("/api/companies/company-1/kill-switch")
        .send({ scope: "company", reason: "Emergency halt" })
        .expect(201);

      expect(res.body.id).toBe("ks-1");
      expect(res.body.action).toBe("halt");
      expect(mockSecurity.activateKillSwitch).toHaveBeenCalledWith(
        "company-1",
        "company",
        undefined,
        "local-board",
        "Emergency halt",
      );
    });

    it("POST /companies/:cid/kill-switch passes scopeId when provided", async () => {
      await request(app)
        .post("/api/companies/company-1/kill-switch")
        .send({ scope: "agent", scopeId: "agent-1", reason: "Misbehaving" })
        .expect(201);

      expect(mockSecurity.activateKillSwitch).toHaveBeenCalledWith(
        "company-1",
        "agent",
        "agent-1",
        "local-board",
        "Misbehaving",
      );
    });

    it("POST /companies/:cid/kill-switch/resume resumes from kill switch (200)", async () => {
      const res = await request(app)
        .post("/api/companies/company-1/kill-switch/resume")
        .send({ scope: "company" })
        .expect(200);

      expect(res.body.id).toBe("ks-2");
      expect(res.body.action).toBe("resume");
      expect(mockSecurity.resumeFromKillSwitch).toHaveBeenCalledWith(
        "company-1",
        "company",
        undefined,
        "local-board",
      );
    });

    it("POST /companies/:cid/kill-switch/resume passes scopeId when provided", async () => {
      await request(app)
        .post("/api/companies/company-1/kill-switch/resume")
        .send({ scope: "agent", scopeId: "agent-1" })
        .expect(200);

      expect(mockSecurity.resumeFromKillSwitch).toHaveBeenCalledWith(
        "company-1",
        "agent",
        "agent-1",
        "local-board",
      );
    });

    it("GET /companies/:cid/kill-switch/status returns status (200)", async () => {
      const res = await request(app)
        .get("/api/companies/company-1/kill-switch/status")
        .expect(200);

      expect(res.body.active).toBe(false);
      expect(mockSecurity.getKillSwitchStatus).toHaveBeenCalledWith("company-1");
    });

    it("GET /companies/:cid/kill-switch/status returns active status when kill switch is on", async () => {
      mockSecurity.getKillSwitchStatus.mockResolvedValue({
        active: true,
        since: "2026-01-01T00:00:00Z",
        reason: "Emergency halt",
      });

      const res = await request(app)
        .get("/api/companies/company-1/kill-switch/status")
        .expect(200);

      expect(res.body.active).toBe(true);
      expect(res.body.reason).toBe("Emergency halt");
    });
  });
});
