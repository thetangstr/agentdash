// AgentDash: self-serve-bootstrap — POST /api/companies hands every company it
// creates for a real authenticated user to accessService.promoteSelfServeBootstrapAdmin,
// the one rule shared with the /cos onboarding bootstrap. The rule itself (flag,
// no instance admin, first company, advisory lock) is exercised on embedded
// Postgres in self-serve-bootstrap-first-admin.test.ts.

import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { companyRoutes } from "../routes/companies.js";
import { errorHandler } from "../middleware/error-handler.js";

// fakeDb.select().from().where() resolves to [] so authUsers email lookups find
// nothing. The promotion lives in the access service, mocked below.
const fakeDb = {
  select: vi.fn(() => ({
    from: () => ({
      where: () => Promise.resolve([]),
    }),
  })),
} as any;

let createMock: ReturnType<typeof vi.fn>;
let ensureMembershipMock: ReturnType<typeof vi.fn>;
let setPrincipalPermissionMock: ReturnType<typeof vi.fn>;
let promoteSelfServeBootstrapAdminMock: ReturnType<typeof vi.fn>;
let hasActiveCompanyMock: ReturnType<typeof vi.fn>;

vi.mock("../services/index.js", () => ({
  agentRunService: vi.fn().mockReturnValue({ recordRun: vi.fn(), monthlyCount: vi.fn(), monthlyCountByAgent: vi.fn() }),
  agentInstructionRefreshService: () => ({ refreshForAgent: vi.fn(), refreshForRole: vi.fn() }),
  ISSUE_LIST_DEFAULT_LIMIT: 50,
  companyService: () => ({
    hasActiveCompany: (...args: unknown[]) => hasActiveCompanyMock(...args),
    list: vi.fn().mockResolvedValue([]),
    stats: vi.fn().mockResolvedValue({}),
    getById: vi.fn(),
    create: (...args: unknown[]) => createMock(...args),
    findByEmailDomain: vi.fn().mockResolvedValue(null),
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
    promoteSelfServeBootstrapAdmin: (...args: unknown[]) => promoteSelfServeBootstrapAdminMock(...args),
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

function buildApp(source = "session") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: [],
      isInstanceAdmin: false,
      source,
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
    emailDomain: null,
  });
  ensureMembershipMock = vi.fn().mockResolvedValue({});
  setPrincipalPermissionMock = vi.fn().mockResolvedValue(undefined);
  promoteSelfServeBootstrapAdminMock = vi.fn().mockResolvedValue(true);
  hasActiveCompanyMock = vi.fn().mockResolvedValue(false);
});

afterEach(() => {
  delete process.env.AGENTDASH_SELF_SERVE_BOOTSTRAP;
  delete process.env.AGENTDASH_ALLOW_MULTI_COMPANY;
  vi.clearAllMocks();
});

describe("POST /api/companies — self-serve-bootstrap instance admin promotion", () => {
  it("hands the created company and its creator to the shared promotion rule", async () => {
    process.env.AGENTDASH_SELF_SERVE_BOOTSTRAP = "true";
    const res = await request(buildApp()).post("/api/companies").send({ name: "Acme" });

    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalled();
    expect(promoteSelfServeBootstrapAdminMock).toHaveBeenCalledWith("user-1", "company-1");
  });

  it("does not attempt promotion for the local_implicit actor", async () => {
    process.env.AGENTDASH_SELF_SERVE_BOOTSTRAP = "true";
    const res = await request(buildApp("local_implicit")).post("/api/companies").send({ name: "Acme" });

    expect(res.status).toBe(201);
    expect(promoteSelfServeBootstrapAdminMock).not.toHaveBeenCalled();
  });

});
