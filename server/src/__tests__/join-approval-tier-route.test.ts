import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalStripeSecretKey = process.env.STRIPE_SECRET_KEY;
const originalBillingDisabled = process.env.AGENTDASH_BILLING_DISABLED;
const logActivityMock = vi.fn();
const notifyHireApprovedMock = vi.fn().mockResolvedValue(undefined);
const seatSyncMock = vi.fn().mockResolvedValue(undefined);
const ensureMembershipMock = vi.fn().mockResolvedValue(undefined);
const setPrincipalGrantsMock = vi.fn().mockResolvedValue(undefined);
const agentCreateMock = vi.fn();
const agentListMock = vi.fn();
const tierDepsMock = {
  getCompany: vi.fn(async (_id: string) => ({ planTier: "pro_active" })),
  counts: {
    humans: vi.fn(async (_companyId: string) => 0),
    agents: vi.fn(async (_companyId: string) => 0),
  },
};

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => ({
      isInstanceAdmin: vi.fn(),
      canUser: vi.fn(),
      hasPermission: vi.fn(),
      ensureMembership: ensureMembershipMock,
      setPrincipalGrants: setPrincipalGrantsMock,
    }),
    agentService: () => ({
      list: agentListMock,
      create: agentCreateMock,
      getById: vi.fn(),
    }),
    boardAuthService: () => ({
      createChallenge: vi.fn(),
      resolveBoardAccess: vi.fn(),
      assertCurrentBoardKey: vi.fn(),
      revokeBoardApiKey: vi.fn(),
    }),
    deduplicateAgentName: (name: string) => name,
    logActivity: (...args: unknown[]) => logActivityMock(...args),
    notifyHireApproved: (...args: unknown[]) => notifyHireApprovedMock(...args),
  }));
  vi.doMock("../middleware/build-tier-deps.js", () => ({
    buildRequireTierDeps: () => tierDepsMock,
  }));
  vi.doMock("../services/seat-quantity-syncer.js", () => ({
    seatQuantitySyncer: () => ({ onMembershipChanged: seatSyncMock }),
  }));
}

type JoinRequestRow = {
  id: string;
  companyId: string;
  inviteId: string;
  requestType: "human" | "agent";
  status: string;
  requestingUserId: string | null;
  agentName: string | null;
  adapterType: string | null;
  capabilities: string[] | null;
  agentDefaultsPayload: Record<string, unknown> | null;
  createdAgentId: string | null;
  claimSecretHash: string | null;
};

function joinRequestRow(overrides: Partial<JoinRequestRow>): JoinRequestRow {
  return {
    id: "join-1",
    companyId: "company-1",
    inviteId: "invite-1",
    requestType: "human",
    status: "pending_approval",
    requestingUserId: "user-2",
    agentName: null,
    adapterType: null,
    capabilities: null,
    agentDefaultsPayload: null,
    createdAgentId: null,
    claimSecretHash: "hash",
    ...overrides,
  };
}

function inviteRow() {
  return {
    id: "invite-1",
    companyId: "company-1",
    inviteType: "company_join",
    allowedJoinTypes: "both",
    defaultsPayload: null,
  };
}

function createDbStub(
  joinRequest: JoinRequestRow,
  options: { lockedJoinRequest?: JoinRequestRow } = {},
) {
  const selectQueue: unknown[][] = [
    [joinRequest],
    [inviteRow()],
    [options.lockedJoinRequest ?? joinRequest],
    [inviteRow()],
  ];
  const db: any = {
    execute: vi.fn().mockResolvedValue([]),
    transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(db)),
    select: vi.fn(() => ({
      from: () => ({
        where: () => Promise.resolve(selectQueue.shift() ?? []),
      }),
    })),
    update: vi.fn(() => ({
      set(values: Record<string, unknown>) {
        return {
          where() {
            return {
              returning: () =>
                Promise.resolve([{ ...joinRequest, ...values }]),
            };
          },
        };
      },
    })),
  };
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
      source: "local_implicit",
      userId: "owner-1",
      companyIds: ["company-1"],
    };
    next();
  });
  app.use(
    "/api",
    accessRoutes(db as any, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("POST /companies/:companyId/join-requests/:requestId/approve Free tier caps", () => {
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
    tierDepsMock.getCompany.mockResolvedValue({ planTier: "free" });
    tierDepsMock.counts.humans.mockResolvedValue(0);
    tierDepsMock.counts.agents.mockResolvedValue(0);
    agentListMock.mockResolvedValue([{ id: "ceo-1", role: "ceo", reportsTo: null }]);
    agentCreateMock.mockResolvedValue({
      id: "agent-join-1",
      role: "general",
      status: "idle",
    });
  });

  afterEach(() => {
    if (originalStripeSecretKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalStripeSecretKey;
    if (originalBillingDisabled === undefined) delete process.env.AGENTDASH_BILLING_DISABLED;
    else process.env.AGENTDASH_BILLING_DISABLED = originalBillingDisabled;
  });

  it("blocks approving a human join request after the Free human seat is used", async () => {
    tierDepsMock.counts.humans.mockResolvedValue(1);
    const db = createDbStub(joinRequestRow({ requestType: "human" }));
    const app = await createApp(db);

    const res = await request(app)
      .post("/api/companies/company-1/join-requests/join-1/approve")
      .send({});

    expect(res.status).toBe(402);
    expect(res.body.code).toBe("seat_cap_exceeded");
    expect(ensureMembershipMock).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("blocks approving an agent join request after the Free agent slot is used", async () => {
    tierDepsMock.counts.agents.mockResolvedValue(1);
    const db = createDbStub(joinRequestRow({
      requestType: "agent",
      requestingUserId: null,
      agentName: "Ops Agent",
    }));
    const app = await createApp(db);

    const res = await request(app)
      .post("/api/companies/company-1/join-requests/join-1/approve")
      .send({});

    expect(res.status).toBe(402);
    expect(res.body.code).toBe("agent_cap_exceeded");
    expect(agentCreateMock).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("allows approving the first Free agent join request when only the human seat is used", async () => {
    tierDepsMock.counts.humans.mockResolvedValue(1);
    tierDepsMock.counts.agents.mockResolvedValue(0);
    const db = createDbStub(joinRequestRow({
      requestType: "agent",
      requestingUserId: null,
      agentName: "Ops Agent",
    }));
    const app = await createApp(db);

    const res = await request(app)
      .post("/api/companies/company-1/join-requests/join-1/approve")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(agentCreateMock).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ name: "Ops Agent" }),
    );
    expect(ensureMembershipMock).toHaveBeenCalledWith(
      "company-1",
      "agent",
      "agent-join-1",
      "member",
      "active",
    );
  });

  it("checks the locked join-request status before enforcing Free tier capacity", async () => {
    tierDepsMock.counts.humans.mockResolvedValue(1);
    const db = createDbStub(
      joinRequestRow({ requestType: "human", status: "pending_approval" }),
      {
        lockedJoinRequest: joinRequestRow({
          requestType: "human",
          status: "approved",
        }),
      },
    );
    const app = await createApp(db);

    const res = await request(app)
      .post("/api/companies/company-1/join-requests/join-1/approve")
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Join request is not pending");
    expect(tierDepsMock.counts.humans).not.toHaveBeenCalled();
    expect(ensureMembershipMock).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });
});
