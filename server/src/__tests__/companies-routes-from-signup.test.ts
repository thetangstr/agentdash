// AgentDash (Phase E): POST /api/companies?fromSignup=1 must return 409 if
// the user is already a member of any workspace. The SPA's /company-create
// page sets that query param so an invitee who navigates back from /cos
// gets redirected instead of accidentally creating a duplicate workspace.
//
// Plain POST /api/companies (without ?fromSignup=1) keeps existing behavior
// — non-Better-Auth callers (CLI bootstrap, scripts, e2e helpers) that
// legitimately create multiple companies are unaffected.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { companyRoutes } from "../routes/companies.js";
import { errorHandler } from "../middleware/error-handler.js";

const acmeUser = { id: "user-1", email: "alice@acme.com" };

const fakeDb = {
  select: vi.fn(() => ({
    from: () => ({
      where: () => Promise.resolve([{ email: acmeUser.email }]),
    }),
  })),
} as any;

let createMock: ReturnType<typeof vi.fn>;
let findByEmailDomainMock: ReturnType<typeof vi.fn>;
let ensureMembershipMock: ReturnType<typeof vi.fn>;
let setPrincipalPermissionMock: ReturnType<typeof vi.fn>;

vi.mock("../services/index.js", () => ({
    agentInstructionRefreshService: () => ({ refreshForAgent: vi.fn(), refreshForRole: vi.fn() }),
    ISSUE_LIST_DEFAULT_LIMIT: 50,
  companyService: () => ({
    hasActiveCompany: vi.fn().mockResolvedValue(false),
    list: vi.fn().mockResolvedValue([]),
    stats: vi.fn().mockResolvedValue({}),
    getById: vi.fn(),
    create: (...args: unknown[]) => createMock(...args),
    findByEmailDomain: (...args: unknown[]) => findByEmailDomainMock(...args),
    update: vi.fn(),
    archive: vi.fn(),
    remove: vi.fn(),
  }),
  companyPortabilityService: () => ({
    exportBundle: vi.fn(),
    previewExport: vi.fn(),
    previewImport: vi.fn(),
    importBundle: vi.fn(),
  }),
  accessService: () => ({
    canUser: vi.fn(),
    ensureMembership: (...args: unknown[]) => ensureMembershipMock(...args),
    setPrincipalPermission: (...args: unknown[]) => setPrincipalPermissionMock(...args),
  }),
  budgetService: () => ({ upsertPolicy: vi.fn() }),
  agentService: () => ({ getById: vi.fn() }),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(),
    listFeedbackTraces: vi.fn(),
    getFeedbackTraceById: vi.fn(),
    saveIssueVote: vi.fn(),
  }),
  logActivity: vi.fn(),
}));

function buildApp(actor: {
  userId: string;
  companyIds: string[];
  isInstanceAdmin?: boolean;
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: actor.userId,
      companyIds: actor.companyIds,
      isInstanceAdmin: actor.isInstanceAdmin ?? false,
      source: "session",
    };
    next();
  });
  app.use("/api/companies", companyRoutes(fakeDb, undefined, {}));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  createMock = vi.fn().mockResolvedValue({
    id: "company-1",
    name: "Acme",
    budgetMonthlyCents: 0,
    emailDomain: "acme.com",
  });
  findByEmailDomainMock = vi.fn().mockResolvedValue(null);
  ensureMembershipMock = vi.fn().mockResolvedValue({});
  setPrincipalPermissionMock = vi.fn().mockResolvedValue(undefined);
});

describe("POST /api/companies?fromSignup=1 — Phase E invite-flow guard", () => {
  it("returns 409 already_member when the user already has a company membership", async () => {
    const app = buildApp({ userId: "user-1", companyIds: ["company-existing"] });
    const res = await request(app)
      .post("/api/companies?fromSignup=1")
      .send({ name: "Acme Two" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "already_member",
      existingCompanyId: "company-existing",
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("returns 409 also when fromSignup=true (string variant)", async () => {
    const app = buildApp({ userId: "user-1", companyIds: ["company-existing"] });
    const res = await request(app)
      .post("/api/companies?fromSignup=true")
      .send({ name: "Acme Two" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("already_member");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("creates the company normally when the user has no existing membership (first signup)", async () => {
    const app = buildApp({ userId: "user-1", companyIds: [] });
    const res = await request(app)
      .post("/api/companies?fromSignup=1")
      .send({ name: "Acme" });

    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalled();
  });

  it("does NOT trigger the 409 when fromSignup is absent (CLI / scripts / e2e helpers)", async () => {
    // Non-Better-Auth callers that legitimately create multiple companies
    // must continue to work. The guard is opt-in via the SPA's query param.
    const app = buildApp({ userId: "user-1", companyIds: ["company-existing"] });
    const res = await request(app).post("/api/companies").send({ name: "Acme Two" });

    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalled();
  });
});
