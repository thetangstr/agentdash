import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- hoisted mocks ----

const mockSignUpEmail = vi.hoisted(() => vi.fn());
const mockRequestPasswordReset = vi.hoisted(() => vi.fn());
const mockAuth = vi.hoisted(() => ({
  api: {
    signUpEmail: mockSignUpEmail,
    requestPasswordReset: mockRequestPasswordReset,
  },
}));

const mockCompanyService = vi.hoisted(() => ({
  create: vi.fn(),
}));

const mockOnboardingOrchestrator = vi.hoisted(() => ({
  bootstrap: vi.fn(),
}));

const mockDb = vi.hoisted(() => ({
  insert: vi.fn(),
  select: vi.fn(),
}));

// Mock the onboarding orchestrator module
vi.mock("../services/onboarding-orchestrator.js", () => ({
  onboardingOrchestrator: vi.fn(() => mockOnboardingOrchestrator),
  OnboardingTierCapacityExceededError: class OnboardingTierCapacityExceededError extends Error {
    action: string;
    code: string;
    constructor(action: string) {
      super("Tier capacity exceeded");
      this.action = action;
      this.code = "tier_capacity_exceeded";
    }
  },
}));

// Mock the companies service
vi.mock("../services/companies.js", () => ({
  companyService: vi.fn(() => mockCompanyService),
  SingleCompanyInstallationError: class SingleCompanyInstallationError extends Error {
    code = "single_company_installation" as const;
    existingCompanyId: string | null;
    constructor(existingCompanyId: string | null) {
      super("Single company installation");
      this.existingCompanyId = existingCompanyId;
    }
  },
}));

// Mock the services index
vi.mock("../services/index.js", () => ({
  companyService: vi.fn(() => mockCompanyService),
  agentService: vi.fn(() => ({})),
  accessService: vi.fn(() => ({})),
  agentInstructionsService: vi.fn(() => ({})),
  conversationService: vi.fn(() => ({})),
  onboardingOrchestrator: vi.fn(() => mockOnboardingOrchestrator),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---- test helpers ----

const PROVISION_KEY = "test-provision-secret-key";
const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const COS_AGENT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONVERSATION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

let routeModule: typeof import("../routes/provision-user.js") | null = null;

async function loadRouteModule() {
  routeModule ??= await import("../routes/provision-user.js");
  return routeModule;
}

async function buildApp(provisionKey: string | undefined) {
  const { provisionUserRoutes } = await loadRouteModule();
  const app = express();
  app.use(express.json());
  // inject actor (provision endpoint doesn't use actor middleware — it uses its own key check)
  app.use((req, _res, next) => {
    (req as any).actor = { type: "none" };
    next();
  });
  app.use("/api/onboarding", provisionUserRoutes(mockDb as any, mockAuth as any, { provisionKey }));
  // minimal error handler
  app.use((err: any, _req: any, res: any, _next: any) => {
    const status = err.status ?? 500;
    res.status(status).json({ error: err.message, code: err.code });
  });
  return app;
}

describe("POST /api/onboarding/provision-user", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENTDASH_PROVISION_KEY;

    // Default happy-path mock responses
    mockSignUpEmail.mockResolvedValue({ user: { id: USER_ID, email: "alice@example.com" } });
    mockRequestPasswordReset.mockResolvedValue(undefined);
    mockCompanyService.create.mockResolvedValue({ id: COMPANY_ID, name: "Acme Corp" });
    mockOnboardingOrchestrator.bootstrap.mockResolvedValue({
      companyId: COMPANY_ID,
      cosAgentId: COS_AGENT_ID,
      conversationId: CONVERSATION_ID,
    });

    // mock db.insert for membership
    const mockReturning = vi.fn().mockResolvedValue([{ id: "mem-1" }]);
    const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
    mockDb.insert.mockReturnValue({ values: mockValues });

    // mock db.select for duplicate-email check
    const mockWhere = vi.fn().mockResolvedValue([]);
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    mockDb.select.mockReturnValue({ from: mockFrom });
  });

  describe("auth gate — AGENTDASH_PROVISION_KEY unset", () => {
    it("rejects with 401 when env var is unset and no header", async () => {
      const app = await buildApp(undefined);
      const res = await request(app)
        .post("/api/onboarding/provision-user")
        .send({ email: "alice@example.com", name: "Alice", companyName: "Acme" });
      expect(res.status).toBe(401);
    });

    it("rejects with 401 even when header is present but env var is unset", async () => {
      const app = await buildApp(undefined);
      const res = await request(app)
        .post("/api/onboarding/provision-user")
        .set("x-provision-key", "anything")
        .send({ email: "alice@example.com", name: "Alice", companyName: "Acme" });
      expect(res.status).toBe(401);
    });
  });

  describe("auth gate — AGENTDASH_PROVISION_KEY set", () => {
    it("rejects with 401 when x-provision-key header is missing", async () => {
      const app = await buildApp(PROVISION_KEY);
      const res = await request(app)
        .post("/api/onboarding/provision-user")
        .send({ email: "alice@example.com", name: "Alice", companyName: "Acme" });
      expect(res.status).toBe(401);
    });

    it("rejects with 403 when x-provision-key header is wrong", async () => {
      const app = await buildApp(PROVISION_KEY);
      const res = await request(app)
        .post("/api/onboarding/provision-user")
        .set("x-provision-key", "wrong-key")
        .send({ email: "alice@example.com", name: "Alice", companyName: "Acme" });
      expect(res.status).toBe(403);
    });

    it("rejects with 403 when key is almost-correct (timing-safe compare)", async () => {
      const app = await buildApp(PROVISION_KEY);
      const res = await request(app)
        .post("/api/onboarding/provision-user")
        .set("x-provision-key", PROVISION_KEY + "x")
        .send({ email: "alice@example.com", name: "Alice", companyName: "Acme" });
      expect(res.status).toBe(403);
    });
  });

  describe("input validation", () => {
    it("rejects with 400 when email is missing", async () => {
      const app = await buildApp(PROVISION_KEY);
      const res = await request(app)
        .post("/api/onboarding/provision-user")
        .set("x-provision-key", PROVISION_KEY)
        .send({ name: "Alice", companyName: "Acme" });
      expect(res.status).toBe(400);
    });

    it("rejects with 400 when email is invalid format", async () => {
      const app = await buildApp(PROVISION_KEY);
      const res = await request(app)
        .post("/api/onboarding/provision-user")
        .set("x-provision-key", PROVISION_KEY)
        .send({ email: "not-an-email", name: "Alice", companyName: "Acme" });
      expect(res.status).toBe(400);
    });

    it("rejects with 400 when name is missing", async () => {
      const app = await buildApp(PROVISION_KEY);
      const res = await request(app)
        .post("/api/onboarding/provision-user")
        .set("x-provision-key", PROVISION_KEY)
        .send({ email: "alice@example.com", companyName: "Acme" });
      expect(res.status).toBe(400);
    });

    it("rejects with 400 when companyName is missing", async () => {
      const app = await buildApp(PROVISION_KEY);
      const res = await request(app)
        .post("/api/onboarding/provision-user")
        .set("x-provision-key", PROVISION_KEY)
        .send({ email: "alice@example.com", name: "Alice" });
      expect(res.status).toBe(400);
    });
  });

  describe("happy path", () => {
    it("returns 201 with userId, companyId, cosAgentId — never returns password", async () => {
      const app = await buildApp(PROVISION_KEY);
      const res = await request(app)
        .post("/api/onboarding/provision-user")
        .set("x-provision-key", PROVISION_KEY)
        .send({ email: "alice@example.com", name: "Alice", companyName: "Acme Corp" });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        userId: USER_ID,
        companyId: COMPANY_ID,
        cosAgentId: COS_AGENT_ID,
      });
      // Must NOT leak password or token
      expect(res.body).not.toHaveProperty("password");
      expect(res.body).not.toHaveProperty("token");
    });

    it("calls signUpEmail with the provided email and name", async () => {
      const app = await buildApp(PROVISION_KEY);
      await request(app)
        .post("/api/onboarding/provision-user")
        .set("x-provision-key", PROVISION_KEY)
        .send({ email: "alice@example.com", name: "Alice", companyName: "Acme Corp" });

      expect(mockSignUpEmail).toHaveBeenCalledOnce();
      const callArgs = mockSignUpEmail.mock.calls[0][0];
      expect(callArgs.body.email).toBe("alice@example.com");
      expect(callArgs.body.name).toBe("Alice");
      // password must be a non-empty string — we don't check exact value (random)
      expect(typeof callArgs.body.password).toBe("string");
      expect(callArgs.body.password.length).toBeGreaterThan(16);
    });

    it("triggers a password-reset email via requestPasswordReset", async () => {
      const app = await buildApp(PROVISION_KEY);
      await request(app)
        .post("/api/onboarding/provision-user")
        .set("x-provision-key", PROVISION_KEY)
        .send({ email: "alice@example.com", name: "Alice", companyName: "Acme Corp" });

      expect(mockRequestPasswordReset).toHaveBeenCalledOnce();
      const callArgs = mockRequestPasswordReset.mock.calls[0][0];
      expect(callArgs.body.email).toBe("alice@example.com");
    });

    it("calls bootstrap with the new userId to provision CoS", async () => {
      const app = await buildApp(PROVISION_KEY);
      await request(app)
        .post("/api/onboarding/provision-user")
        .set("x-provision-key", PROVISION_KEY)
        .send({ email: "alice@example.com", name: "Alice", companyName: "Acme Corp" });

      expect(mockOnboardingOrchestrator.bootstrap).toHaveBeenCalledOnce();
      // Identity is passed through (id + name) so bootstrap skips the auth_users
      // lookup the just-created user isn't yet visible to.
      expect(mockOnboardingOrchestrator.bootstrap).toHaveBeenCalledWith(USER_ID, { id: USER_ID, name: "Alice" });
    });

    it("accepts optional redirectTo in body without error", async () => {
      const app = await buildApp(PROVISION_KEY);
      const res = await request(app)
        .post("/api/onboarding/provision-user")
        .set("x-provision-key", PROVISION_KEY)
        .send({ email: "alice@example.com", name: "Alice", companyName: "Acme Corp", redirectTo: "/dashboard" });

      expect(res.status).toBe(201);
    });
  });

  describe("duplicate email — 409", () => {
    it("returns 409 when signUpEmail indicates user already exists", async () => {
      mockSignUpEmail.mockRejectedValue(
        Object.assign(new Error("User already exists"), { status: 422, code: "USER_ALREADY_EXISTS" }),
      );
      const app = await buildApp(PROVISION_KEY);
      const res = await request(app)
        .post("/api/onboarding/provision-user")
        .set("x-provision-key", PROVISION_KEY)
        .send({ email: "alice@example.com", name: "Alice", companyName: "Acme Corp" });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already exists/i);
    });
  });
});
