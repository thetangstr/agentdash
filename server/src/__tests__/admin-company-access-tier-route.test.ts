import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalStripeSecretKey = process.env.STRIPE_SECRET_KEY;
const originalBillingDisabled = process.env.AGENTDASH_BILLING_DISABLED;

const listUserCompanyAccessMock = vi.fn();
const setUserCompanyAccessMock = vi.fn();
const isInstanceAdminMock = vi.fn();
const tierDepsMock = {
  getCompany: vi.fn(async (_id: string) => ({ planTier: "free" })),
  counts: {
    humans: vi.fn(async (_companyId: string) => 1),
    agents: vi.fn(async (_companyId: string) => 0),
  },
};
const companyId = "11111111-1111-4111-8111-111111111111";

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => ({
      isInstanceAdmin: isInstanceAdminMock,
      listUserCompanyAccess: listUserCompanyAccessMock,
      setUserCompanyAccess: setUserCompanyAccessMock,
      canUser: vi.fn(),
      hasPermission: vi.fn(),
      ensureMembership: vi.fn(),
      setPrincipalGrants: vi.fn(),
    }),
    agentService: () => ({
      list: vi.fn(),
      create: vi.fn(),
      getById: vi.fn(),
    }),
    boardAuthService: () => ({
      createChallenge: vi.fn(),
      resolveBoardAccess: vi.fn(),
      assertCurrentBoardKey: vi.fn(),
      revokeBoardApiKey: vi.fn(),
    }),
    deduplicateAgentName: (name: string) => name,
    logActivity: vi.fn(),
    notifyHireApproved: vi.fn(),
  }));
  vi.doMock("../middleware/build-tier-deps.js", () => ({
    buildRequireTierDeps: () => tierDepsMock,
  }));
  vi.doMock("../services/seat-quantity-syncer.js", () => ({
    seatQuantitySyncer: () => ({ onMembershipChanged: vi.fn() }),
  }));
}

function createDbStub() {
  const db: any = {
    execute: vi.fn().mockResolvedValue([]),
  };
  db.transaction = vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(db));
  return db;
}

async function createApp(db: unknown) {
  const [{ accessRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/access.js"),
    import("../middleware/error-handler.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      source: "session",
      userId: "admin-1",
      companyIds: [companyId],
      isInstanceAdmin: true,
    };
    next();
  });
  app.use(
    "/api",
    accessRoutes(db as any, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("PUT /admin/users/:userId/company-access Free tier caps", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/access.js");
    vi.doUnmock("../middleware/error-handler.js");
    vi.doUnmock("../middleware/build-tier-deps.js");
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../services/seat-quantity-syncer.js");
    registerModuleMocks();
    vi.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "sk_test_free_caps";
    delete process.env.AGENTDASH_BILLING_DISABLED;
    isInstanceAdminMock.mockResolvedValue(true);
    listUserCompanyAccessMock.mockResolvedValue([]);
    setUserCompanyAccessMock.mockResolvedValue([]);
    tierDepsMock.getCompany.mockResolvedValue({ planTier: "free" });
    tierDepsMock.counts.humans.mockResolvedValue(1);
    tierDepsMock.counts.agents.mockResolvedValue(0);
  });

  afterEach(() => {
    if (originalStripeSecretKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalStripeSecretKey;
    if (originalBillingDisabled === undefined) delete process.env.AGENTDASH_BILLING_DISABLED;
    else process.env.AGENTDASH_BILLING_DISABLED = originalBillingDisabled;
  });

  it("blocks instance-admin access grants that would add a second Free human", async () => {
    const db = createDbStub();
    const app = await createApp(db);

    const res = await request(app)
      .put("/api/admin/users/user-2/company-access")
      .send({ companyIds: [companyId] });

    expect(res.status).toBe(402);
    expect(res.body.code).toBe("seat_cap_exceeded");
    expect(setUserCompanyAccessMock).not.toHaveBeenCalled();
    expect(db.execute).toHaveBeenCalled();
  });
});
