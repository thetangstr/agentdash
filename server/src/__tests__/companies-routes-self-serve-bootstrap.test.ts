// AgentDash: self-serve-bootstrap — POST /api/companies promotes the first
// real authenticated user of a fresh instance (no instance_admin, no company)
// to instance_admin, but ONLY when AGENTDASH_SELF_SERVE_BOOTSTRAP === "true".
// When the flag is off, behavior is unchanged (no promotion).

import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { companyRoutes } from "../routes/companies.js";
import { errorHandler } from "../middleware/error-handler.js";

// fakeDb.select().from().where() resolves to [] so the instance_admin count
// query (the route's eligibility pre-check) returns 0 — a fresh instance with
// no admins. authUsers email lookups also resolve to [] here, which is fine for
// a local_implicit-free actor. The atomic, advisory-locked promotion lives in
// the access service (promoteFirstInstanceAdmin), which is mocked below — so the
// route never opens a real transaction in this unit test.
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
let promoteFirstInstanceAdminMock: ReturnType<typeof vi.fn>;
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
    promoteFirstInstanceAdmin: (...args: unknown[]) => promoteFirstInstanceAdminMock(...args),
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

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: [],
      isInstanceAdmin: false,
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
    emailDomain: null,
  });
  ensureMembershipMock = vi.fn().mockResolvedValue({});
  setPrincipalPermissionMock = vi.fn().mockResolvedValue(undefined);
  promoteFirstInstanceAdminMock = vi.fn().mockResolvedValue(true);
  hasActiveCompanyMock = vi.fn().mockResolvedValue(false);
});

afterEach(() => {
  delete process.env.AGENTDASH_SELF_SERVE_BOOTSTRAP;
  delete process.env.AGENTDASH_ALLOW_MULTI_COMPANY;
  vi.clearAllMocks();
});

describe("POST /api/companies — self-serve-bootstrap instance admin promotion", () => {
  it("promotes the first user to instance_admin when the flag is on and the instance is fresh", async () => {
    process.env.AGENTDASH_SELF_SERVE_BOOTSTRAP = "true";
    const app = buildApp();

    const res = await request(app).post("/api/companies").send({ name: "Acme" });

    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalled();
    expect(promoteFirstInstanceAdminMock).toHaveBeenCalledWith("user-1");
  });

  it("does NOT promote when the flag is off (default behavior)", async () => {
    // Flag intentionally unset.
    const app = buildApp();

    const res = await request(app).post("/api/companies").send({ name: "Acme" });

    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalled();
    expect(promoteFirstInstanceAdminMock).not.toHaveBeenCalled();
  });

  it("does NOT promote when the flag is on but a company already exists", async () => {
    process.env.AGENTDASH_SELF_SERVE_BOOTSTRAP = "true";
    hasActiveCompanyMock = vi.fn().mockResolvedValue(true);
    const app = buildApp();

    const res = await request(app).post("/api/companies").send({ name: "Acme" });

    // With an existing company the single-company guard returns 409 before
    // creation — the key assertion is that no promotion occurs.
    expect(promoteFirstInstanceAdminMock).not.toHaveBeenCalled();
    expect([201, 409]).toContain(res.status);
  });

  it("does NOT promote when a company exists even if creation proceeds (eligibility gate, not the 409 guard)", async () => {
    // Override the single-company guard so creation succeeds (201) WITH a
    // company already present. This isolates the `!hasExistingCompany`
    // eligibility term: promotion must be suppressed because a company exists,
    // not merely because the guard short-circuited with a 409.
    process.env.AGENTDASH_SELF_SERVE_BOOTSTRAP = "true";
    process.env.AGENTDASH_ALLOW_MULTI_COMPANY = "true";
    hasActiveCompanyMock = vi.fn().mockResolvedValue(true);
    const app = buildApp();

    const res = await request(app).post("/api/companies").send({ name: "Acme" });

    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalled();
    expect(promoteFirstInstanceAdminMock).not.toHaveBeenCalled();
  });
});
