// AgentDash (AGE-55): FRE Plan B — invite-only signup + domain-keyed companies.
// Verifies the company-create route derives email_domain from the creator,
// returns 409 `domain_already_claimed` on collision, and respects the
// PAPERCLIP_ALLOW_MULTI_TENANT_PER_DOMAIN flag.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { companyRoutes } from "../routes/companies.js";
import { errorHandler } from "../middleware/error-handler.js";
import { DomainAlreadyClaimedError } from "../services/companies.js";

const ACTOR = {
  type: "board" as const,
  userId: "user-1",
  companyIds: [],
  isInstanceAdmin: true,
  source: "session" as const,
};

const acmeUser = { id: "user-1", email: "alice@acme.com" };
const gmailUser = { id: "user-2", email: "alice@gmail.com" };

const fakeDb = {
  select: vi.fn(),
} as any;

let createMock: ReturnType<typeof vi.fn>;
let findByEmailDomainMock: ReturnType<typeof vi.fn>;
let ensureMembershipMock: ReturnType<typeof vi.fn>;

vi.mock("../services/index.js", () => ({
  companyService: () => ({
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

function buildApp(opts: { actorEmail?: string; allowMultiTenantPerDomain?: boolean }) {
  // Stub authUsers lookup chain (db.select().from().where().then()).
  fakeDb.select = vi.fn(() => ({
    from: () => ({
      where: () => Promise.resolve(opts.actorEmail ? [{ email: opts.actorEmail }] : []),
    }),
  }));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = ACTOR;
    next();
  });
  app.use("/api/companies", companyRoutes(fakeDb, undefined, {
    allowMultiTenantPerDomain: opts.allowMultiTenantPerDomain ?? false,
  }));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  createMock = vi.fn();
  findByEmailDomainMock = vi.fn();
  ensureMembershipMock = vi.fn().mockResolvedValue({});
});

describe("POST /api/companies — FRE Plan B email_domain (AGE-55)", () => {
  it("derives the bare domain for corp emails and persists it", async () => {
    findByEmailDomainMock.mockResolvedValue(null);
    createMock.mockResolvedValue({
      id: "company-1",
      name: "Acme",
      budgetMonthlyCents: 0,
      emailDomain: "acme.com",
    });

    const app = buildApp({ actorEmail: acmeUser.email });
    const res = await request(app).post("/api/companies").send({ name: "Acme" });

    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      name: "Acme",
      emailDomain: "acme.com",
    }));
    expect(ensureMembershipMock).toHaveBeenCalledWith(
      "company-1",
      "user",
      "user-1",
      "owner",
      "active",
    );
  });

  it("derives the full email for free-mail addresses", async () => {
    findByEmailDomainMock.mockResolvedValue(null);
    createMock.mockResolvedValue({
      id: "company-2",
      name: "Personal",
      budgetMonthlyCents: 0,
      emailDomain: "alice@gmail.com",
    });

    const app = buildApp({ actorEmail: gmailUser.email });
    await request(app).post("/api/companies").send({ name: "Personal" }).expect(201);

    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      emailDomain: "alice@gmail.com",
    }));
  });

  it("returns 409 domain_already_claimed when the domain is taken (pre-flight)", async () => {
    findByEmailDomainMock.mockResolvedValue({
      id: "company-existing",
      name: "Acme",
      emailDomain: "acme.com",
    });

    const app = buildApp({ actorEmail: acmeUser.email });
    const res = await request(app).post("/api/companies").send({ name: "Acme Two" });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      code: "domain_already_claimed",
      existingCompanyId: "company-existing",
      contactEmail: null,
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("returns 409 domain_already_claimed when the DB unique index races a duplicate", async () => {
    findByEmailDomainMock.mockResolvedValue(null);
    createMock.mockRejectedValue(new DomainAlreadyClaimedError("acme.com", "company-existing"));

    const app = buildApp({ actorEmail: acmeUser.email });
    const res = await request(app).post("/api/companies").send({ name: "Acme Two" });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      code: "domain_already_claimed",
      existingCompanyId: "company-existing",
      contactEmail: null,
    });
  });

  it("when allowMultiTenantPerDomain=true, skips pre-flight and lets duplicates through", async () => {
    findByEmailDomainMock.mockResolvedValue({
      id: "company-existing",
      name: "Acme",
      emailDomain: "acme.com",
    });
    createMock.mockResolvedValue({
      id: "company-new",
      name: "Acme Two",
      budgetMonthlyCents: 0,
      emailDomain: "acme.com",
    });

    const app = buildApp({ actorEmail: acmeUser.email, allowMultiTenantPerDomain: true });
    const res = await request(app).post("/api/companies").send({ name: "Acme Two" });

    expect(res.status).toBe(201);
    expect(findByEmailDomainMock).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ emailDomain: "acme.com" }));
  });

  it("local_implicit actors (no email) leave email_domain NULL", async () => {
    createMock.mockResolvedValue({
      id: "company-local",
      name: "Local",
      budgetMonthlyCents: 0,
      emailDomain: null,
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        userId: "local-board",
        isInstanceAdmin: true,
        source: "local_implicit",
      };
      next();
    });
    app.use("/api/companies", companyRoutes(fakeDb, undefined, { allowMultiTenantPerDomain: false }));
    app.use(errorHandler);

    const res = await request(app).post("/api/companies").send({ name: "Local" });
    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ emailDomain: null }));
  });
});
