import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logActivityMock = vi.fn();
const originalStripeSecretKey = process.env.STRIPE_SECRET_KEY;
const originalBillingDisabled = process.env.AGENTDASH_BILLING_DISABLED;
const tierDepsMock = {
  getCompany: vi.fn(async (_id: string) => ({ planTier: "pro_active" })),
  counts: {
    humans: vi.fn(async (_companyId: string) => 0),
    agents: vi.fn(async (_companyId: string) => 0),
  },
};

// AgentDash: invite-role-ceiling (P0.5) — lets individual tests stub the
// inviting actor's resolved company role for the role-ceiling checks.
const getMembershipMock = vi.fn(
  async (_companyId: string, _type: string, _userId: string) =>
    null as { status: string; membershipRole: string } | null,
);

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    agentInstructionRefreshService: () => ({ refreshForAgent: vi.fn(), refreshForRole: vi.fn() }),
    ISSUE_LIST_DEFAULT_LIMIT: 50,
    accessService: () => ({
      isInstanceAdmin: vi.fn(),
      canUser: vi.fn(async () => true),
      hasPermission: vi.fn(async () => true),
      getMembership: (...args: [string, string, string]) => getMembershipMock(...args),
    }),
    agentService: () => ({
      getById: vi.fn(),
    }),
    boardAuthService: () => ({
      createChallenge: vi.fn(),
      resolveBoardAccess: vi.fn(),
      assertCurrentBoardKey: vi.fn(),
      revokeBoardApiKey: vi.fn(),
    }),
    deduplicateAgentName: vi.fn(),
    logActivity: (...args: unknown[]) => logActivityMock(...args),
    notifyHireApproved: vi.fn(),
  }));
  vi.doMock("../middleware/build-tier-deps.js", () => ({
    buildRequireTierDeps: () => tierDepsMock,
  }));
}

function createDbStub() {
  const createdInvite = {
    id: "invite-1",
    companyId: "company-1",
    inviteType: "company_join",
    allowedJoinTypes: "human",
    tokenHash: "hash",
    defaultsPayload: { humanRole: "viewer" },
    expiresAt: new Date("2027-03-10T00:00:00.000Z"),
    invitedByUserId: null,
    revokedAt: null,
    acceptedAt: null,
    createdAt: new Date("2026-03-07T00:00:00.000Z"),
    updatedAt: new Date("2026-03-07T00:00:00.000Z"),
  };

  const db = {
    execute: vi.fn().mockResolvedValue([]),
    transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn(db)),
    insert() {
      return {
        values(insertValues: Record<string, unknown>) {
          return {
            returning() {
              return Promise.resolve([{ ...createdInvite, ...insertValues }]);
            },
          };
        },
      };
    },
    select(_shape?: unknown) {
      return {
        from() {
          const query = {
            leftJoin() {
              return query;
            },
            where() {
              return Promise.resolve([{
                name: "Acme Robotics",
                brandColor: "#114488",
                logoAssetId: "logo-1",
              }]);
            },
          };
          return query;
        },
      };
    },
  };
  return db;
}

async function createApp(actor?: Record<string, unknown>) {
  const [{ accessRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/access.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      source: "local_implicit",
      userId: null,
      companyIds: ["company-1"],
    };
    next();
  });
  app.use(
    "/api",
    accessRoutes(createDbStub() as any, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("POST /companies/:companyId/invites", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/access.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.doUnmock("../middleware/build-tier-deps.js");
    registerModuleMocks();
    vi.clearAllMocks();
    logActivityMock.mockReset();
    tierDepsMock.getCompany.mockResolvedValue({ planTier: "pro_active" });
    tierDepsMock.counts.humans.mockResolvedValue(0);
    tierDepsMock.counts.agents.mockResolvedValue(0);
    getMembershipMock.mockReset();
    getMembershipMock.mockResolvedValue(null);
  });

  // A non-local board actor whose company role is resolved via getMembership.
  function boardUserActor(userId = "actor-user") {
    return {
      type: "board",
      source: "board_api_key",
      userId,
      companyIds: ["company-1"],
    } as Record<string, unknown>;
  }

  afterEach(() => {
    if (originalStripeSecretKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalStripeSecretKey;
    if (originalBillingDisabled === undefined) delete process.env.AGENTDASH_BILLING_DISABLED;
    else process.env.AGENTDASH_BILLING_DISABLED = originalBillingDisabled;
  });

  it("returns an absolute invite URL using the request base URL", async () => {
    const app = await createApp();

    const res = await request(app)
      .post("/api/companies/company-1/invites")
      .set("host", "paperclip.example")
      .set("x-forwarded-proto", "https")
      .send({
        allowedJoinTypes: "human",
        humanRole: "member",
      });

    expect(res.status).toBe(201);
    expect(res.body.companyName).toBe("Acme Robotics");
    expect(res.body.invitePath).toMatch(/^\/invite\/pcp_invite_[a-z0-9]{16}$/);
    expect(res.body.inviteUrl).toMatch(/^https:\/\/paperclip\.example\/invite\/pcp_invite_[a-z0-9]{16}$/);
  });

  it("allows agent-only invites on Free workspaces with a human owner but no agent yet", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_free_caps";
    tierDepsMock.getCompany.mockResolvedValue({ planTier: "free" });
    tierDepsMock.counts.humans.mockResolvedValue(1);
    tierDepsMock.counts.agents.mockResolvedValue(0);
    const app = await createApp();

    const res = await request(app)
      .post("/api/companies/company-1/invites")
      .send({ allowedJoinTypes: "agent" });

    expect(res.status).toBe(201);
    expect(res.body.allowedJoinTypes).toBe("agent");
    expect(tierDepsMock.counts.humans).not.toHaveBeenCalled();
    expect(tierDepsMock.counts.agents).toHaveBeenCalledWith("company-1");
  });

  it("blocks human invites on Free workspaces that already have one human", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_free_caps";
    tierDepsMock.getCompany.mockResolvedValue({ planTier: "free" });
    tierDepsMock.counts.humans.mockResolvedValue(1);
    const app = await createApp();

    const res = await request(app)
      .post("/api/companies/company-1/invites")
      .send({ allowedJoinTypes: "human" });

    expect(res.status).toBe(402);
    expect(res.body.code).toBe("seat_cap_exceeded");
  });

  it("allows both-type invites when at least one join type still has Free capacity", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_free_caps";
    tierDepsMock.getCompany.mockResolvedValue({ planTier: "free" });
    tierDepsMock.counts.humans.mockResolvedValue(1);
    tierDepsMock.counts.agents.mockResolvedValue(0);
    const app = await createApp();

    const res = await request(app)
      .post("/api/companies/company-1/invites")
      .send({ allowedJoinTypes: "both" });

    expect(res.status).toBe(201);
    expect(res.body.allowedJoinTypes).toBe("both");
  });

  it("blocks both-type invites when no Free human or agent capacity remains", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_free_caps";
    tierDepsMock.getCompany.mockResolvedValue({ planTier: "free" });
    tierDepsMock.counts.humans.mockResolvedValue(1);
    tierDepsMock.counts.agents.mockResolvedValue(1);
    const app = await createApp();

    const res = await request(app)
      .post("/api/companies/company-1/invites")
      .send({ allowedJoinTypes: "both" });

    expect(res.status).toBe(402);
    expect(res.body.code).toBe("seat_cap_exceeded");
  });

  // AgentDash: invite-role-ceiling (P0.5) — privilege-escalation guard.
  describe("invite role ceiling", () => {
    // Two roles since 2026-08-16: the ceiling rule ("at or below your own")
    // still holds, it just has fewer rungs. Legacy strings normalize before
    // ranking — a stored "owner" ranks as admin, a stored "operator" as
    // member — covered explicitly so the mapping cannot drift.
    it("rejects a member inviting an admin with 403", async () => {
      getMembershipMock.mockResolvedValue({ status: "active", membershipRole: "member" });
      const app = await createApp(boardUserActor());

      const res = await request(app)
        .post("/api/companies/company-1/invites")
        .send({ allowedJoinTypes: "human", humanRole: "admin" });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/role above your own/i);
    });

    it("allows a member inviting a member — equal rank is at the ceiling", async () => {
      getMembershipMock.mockResolvedValue({ status: "active", membershipRole: "member" });
      const app = await createApp(boardUserActor());

      const res = await request(app)
        .post("/api/companies/company-1/invites")
        .send({ allowedJoinTypes: "human", humanRole: "member" });

      expect(res.status).toBe(201);
    });

    it("allows an admin inviting an admin", async () => {
      getMembershipMock.mockResolvedValue({ status: "active", membershipRole: "admin" });
      const app = await createApp(boardUserActor());

      const res = await request(app)
        .post("/api/companies/company-1/invites")
        .send({ allowedJoinTypes: "human", humanRole: "admin" });

      expect(res.status).toBe(201);
    });

    it("ranks a legacy owner row as admin", async () => {
      getMembershipMock.mockResolvedValue({ status: "active", membershipRole: "owner" });
      const app = await createApp(boardUserActor());

      const res = await request(app)
        .post("/api/companies/company-1/invites")
        .send({ allowedJoinTypes: "human", humanRole: "admin" });

      expect(res.status).toBe(201);
    });

    it("ranks a legacy operator row as member — it may not invite an admin", async () => {
      getMembershipMock.mockResolvedValue({ status: "active", membershipRole: "operator" });
      const app = await createApp(boardUserActor());

      const res = await request(app)
        .post("/api/companies/company-1/invites")
        .send({ allowedJoinTypes: "human", humanRole: "admin" });

      expect(res.status).toBe(403);
    });

    /**
     * An agent has no human role, so there was no ceiling to compare against
     * and the check returned early — letting an agent holding `users:invite`
     * mint an invite at ANY role. Probed on the live uat instance before the
     * first fix: an agent created invites at owner, admin, operator and
     * viewer, all 201.
     *
     * The first fix capped agents at `viewer` — read-only participation
     * without authority. The 2026-08-16 role collapse removed that tier: the
     * lowest role is now `member`, which creates projects and agents. There
     * is no longer any role an agent can hand out that does not carry write
     * authority, so agents cannot invite humans AT ALL. A person extends the
     * company, not its workers.
     */
    describe("an agent's ceiling", () => {
      function agentActor() {
        return {
          type: "agent",
          agentId: "agent-1",
          companyId: "company-1",
          source: "agent_key",
          companyIds: ["company-1"],
        } as Record<string, unknown>;
      }

      it("refuses an agent inviting an admin", async () => {
        const app = await createApp(agentActor());
        const res = await request(app)
          .post("/api/companies/company-1/invites")
          .send({ allowedJoinTypes: "human", humanRole: "admin" });

        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/agents cannot invite people/i);
      });

      it("refuses an agent inviting a member", async () => {
        const app = await createApp(agentActor());
        const res = await request(app)
          .post("/api/companies/company-1/invites")
          .send({ allowedJoinTypes: "human", humanRole: "member" });

        expect(res.status).toBe(403);
      });

      it("refuses an agent that names NO role — the default must not sneak past", async () => {
        // The historic bypass shape: invite creation has its own role
        // default, so an agent omitting `humanRole` used to be checked as one
        // role and stored as another. Refusing agents outright closes the
        // shape for good, but only if the no-role request is ALSO refused.
        const app = await createApp(agentActor());
        const res = await request(app)
          .post("/api/companies/company-1/invites")
          .send({ allowedJoinTypes: "human" });

        expect(res.status).toBe(403);
        expect(logActivityMock).not.toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ action: "invite.created" }),
        );
      });

      it("still allows an agent-only invite — hiring agents is not granting authority", async () => {
        // The control case. Without it, a rule that refused agents every
        // invite of any kind would satisfy every assertion above.
        const app = await createApp(agentActor());
        const res = await request(app)
          .post("/api/companies/company-1/invites")
          .send({ allowedJoinTypes: "agent" });

        expect(res.status).toBe(201);
      });

      it("stores member when a human names no role", async () => {
        getMembershipMock.mockResolvedValue({ status: "active", membershipRole: "admin" });
        const app = await createApp(boardUserActor());
        const res = await request(app)
          .post("/api/companies/company-1/invites")
          .send({ allowedJoinTypes: "human" });

        expect(res.status).toBe(201);
        expect(logActivityMock).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            action: "invite.created",
            details: expect.objectContaining({ humanRole: "member" }),
          }),
        );
      });
    });

    it("still allows the local-implicit founding board to invite an admin", async () => {
      const app = await createApp();

      const res = await request(app)
        .post("/api/companies/company-1/invites")
        .send({ allowedJoinTypes: "human", humanRole: "admin" });

      expect(res.status).toBe(201);
    });
  });
});
