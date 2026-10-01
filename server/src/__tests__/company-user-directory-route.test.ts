import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessRoutes } from "../routes/access.js";
import { errorHandler } from "../middleware/index.js";

// AgentDash (GH #505): `canUser` is controllable so the tests can tell a member
// manager (`users:manage_permissions`) from an ordinary member.
const mockCanUser = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentRunService: vi.fn().mockReturnValue({ recordRun: vi.fn(), monthlyCount: vi.fn(), monthlyCountByAgent: vi.fn() }),
    agentInstructionRefreshService: () => ({ refreshForAgent: vi.fn(), refreshForRole: vi.fn() }),
    ISSUE_LIST_DEFAULT_LIMIT: 50,
  accessService: () => ({
    isInstanceAdmin: vi.fn(),
    canUser: mockCanUser,
    hasPermission: vi.fn(),
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
  logActivity: vi.fn(),
  notifyHireApproved: vi.fn(),
}));

function createDbStub() {
  const activeMemberships = [
    { principalId: "user-2", status: "active" as const, membershipRole: "operator" },
    { principalId: "user-1", status: "active" as const, membershipRole: "operator" },
  ];
  const users = [
    { id: "user-1", name: "Dotta", email: "dotta@example.com", image: "https://example.com/dotta.png" },
    { id: "user-2", name: null, email: "alex@example.com", image: null },
  ];

  const isCompanyMembershipsTable = (table: unknown) =>
    !!table &&
    typeof table === "object" &&
    "membershipRole" in table &&
    "principalType" in table &&
    "principalId" in table;
  const isAuthUsersTable = (table: unknown) =>
    !!table &&
    typeof table === "object" &&
    "emailVerified" in table &&
    "createdAt" in table &&
    "updatedAt" in table;
  const isGrantsTable = (table: unknown) =>
    !!table && typeof table === "object" && "permissionKey" in table && "principalId" in table;

  return {
    select() {
      return {
        from(table: unknown) {
          if (isCompanyMembershipsTable(table)) {
            const query = {
              where() {
                return query;
              },
              orderBy() {
                return Promise.resolve(activeMemberships);
              },
            };
            return query;
          }
          if (isAuthUsersTable(table)) {
            return {
              where() {
                return Promise.resolve(users);
              },
            };
          }
          if (isGrantsTable(table)) {
            return {
              where() {
                return Promise.resolve([]);
              },
            };
          }
          throw new Error("Unexpected table");
        },
      };
    },
  };
}

function createApp(actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use(
    "/api",
    accessRoutes(createDbStub() as never, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

const operatorActor = {
  type: "board",
  userId: "user-1",
  source: "session",
  isInstanceAdmin: false,
  companyIds: ["company-1"],
  memberships: [{ companyId: "company-1", membershipRole: "operator", status: "active" }],
} as Express.Request["actor"];

const adminActor = {
  type: "board",
  userId: "user-1",
  source: "session",
  isInstanceAdmin: false,
  companyIds: ["company-1"],
  memberships: [{ companyId: "company-1", membershipRole: "admin", status: "active" }],
} as Express.Request["actor"];

const agentActor = {
  type: "agent",
  agentId: "agent-1",
  companyId: "company-1",
  source: "agent_key",
} as Express.Request["actor"];

function emailsIn(body: unknown): string[] {
  return [...JSON.stringify(body).matchAll(/[a-z0-9.]+@example\.com/g)].map((m) => m[0]);
}

describe("GET /companies/:companyId/user-directory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUser.mockResolvedValue(false);
  });

  it("gives a non-admin member names and ids, and only their own email", async () => {
    const res = await request(createApp(operatorActor)).get("/api/companies/company-1/user-directory");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      users: [
        {
          principalId: "user-2",
          status: "active",
          user: { id: "user-2", name: null, email: null, image: null },
        },
        {
          principalId: "user-1",
          status: "active",
          user: { id: "user-1", name: "Dotta", email: "dotta@example.com", image: "https://example.com/dotta.png" },
        },
      ],
    });
    expect(mockCanUser).toHaveBeenCalledWith("company-1", "user-1", "users:manage_permissions");
  });

  it("gives an agent no email addresses at all (GH #505)", async () => {
    const res = await request(createApp(agentActor)).get("/api/companies/company-1/user-directory");

    expect(res.status).toBe(200);
    expect(emailsIn(res.body)).toEqual([]);
    expect(res.body.users.map((u: { principalId: string; user: { name: string | null } }) => [u.principalId, u.user.name])).toEqual([
      ["user-2", null],
      ["user-1", "Dotta"],
    ]);
    // Agents are refused before any permission lookup.
    expect(mockCanUser).not.toHaveBeenCalled();
  });

  it("keeps every email for a member manager", async () => {
    mockCanUser.mockResolvedValue(true);
    const res = await request(createApp(adminActor)).get("/api/companies/company-1/user-directory");

    expect(res.status).toBe(200);
    expect(emailsIn(res.body).sort()).toEqual(["alex@example.com", "dotta@example.com"]);
  });

  it("keeps every email for the local_trusted board", async () => {
    const res = await request(
      createApp({ type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true } as Express.Request["actor"]),
    ).get("/api/companies/company-1/user-directory");

    expect(res.status).toBe(200);
    expect(emailsIn(res.body).sort()).toEqual(["alex@example.com", "dotta@example.com"]);
  });
});

describe("GET /companies/:companyId/people", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanUser.mockResolvedValue(false);
  });

  it("gives an agent names and ids but no email addresses (GH #505)", async () => {
    const res = await request(createApp(agentActor)).get("/api/companies/company-1/people");

    expect(res.status).toBe(200);
    expect(emailsIn(res.body)).toEqual([]);
    expect(res.body.people).toEqual([
      { userId: "user-2", name: null, email: null, status: "active", membershipRole: "member" },
      { userId: "user-1", name: "Dotta", email: null, status: "active", membershipRole: "member" },
    ]);
  });

  it("gives a non-admin member only their own email", async () => {
    const res = await request(createApp(operatorActor)).get("/api/companies/company-1/people");

    expect(res.status).toBe(200);
    expect(emailsIn(res.body)).toEqual(["dotta@example.com"]);
  });

  it("keeps every email for a member manager", async () => {
    mockCanUser.mockResolvedValue(true);
    const res = await request(createApp(adminActor)).get("/api/companies/company-1/people");

    expect(res.status).toBe(200);
    expect(emailsIn(res.body).sort()).toEqual(["alex@example.com", "dotta@example.com"]);
  });
});
