// AgentDash (AGE-60 + AGE-104): on Pro deployments, the company-create
// route blocks free-mail creator emails (gmail/yahoo/etc) ONLY when the
// user is creating an additional workspace. A user's first workspace is
// always allowed — the signup-time corp-email guard
// (corp-email-signup-guard.ts) is the real safeguard for new accounts;
// this route gate exists for legacy accounts that bypassed it.
//
// Self-hosted Free leaves the gate off (any email works, single-seat cap
// is enforced separately).

import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { companyRoutes } from "../routes/companies.js";
import { errorHandler } from "../middleware/error-handler.js";

// AGE-104: the gate now keys on whether the user already has a workspace.
const ACTOR_WITH_EXISTING = {
  type: "board" as const,
  userId: "user-1",
  companyIds: ["existing-company"], // <-- already has a workspace
  isInstanceAdmin: true,
  source: "session" as const,
};

const ACTOR_NO_COMPANIES = {
  type: "board" as const,
  userId: "user-1",
  companyIds: [], // <-- first workspace
  isInstanceAdmin: true,
  source: "session" as const,
};

const LOCAL_ACTOR = {
  type: "board" as const,
  userId: "local-board",
  companyIds: [],
  isInstanceAdmin: true,
  source: "local_implicit" as const,
};

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
    // Closes #327: the route's #102 single-company guard calls
    // svc.hasActiveCompany() before the create path. Missing this mock
    // surfaced as 500 → tests expecting 400/201 failed. Default to
    // false (no existing company) so the guard waves the create through,
    // which is the right precondition for these tests anyway — they're
    // asserting the FREE-MAIL block, not the single-company block.
    hasActiveCompany: vi.fn().mockResolvedValue(false),
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
    setPrincipalPermission: vi.fn().mockResolvedValue(undefined),
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

function buildApp(opts: {
  actorEmail?: string;
  requireCorpEmail?: boolean;
  actor?:
    | typeof ACTOR_WITH_EXISTING
    | typeof ACTOR_NO_COMPANIES
    | typeof LOCAL_ACTOR;
}) {
  fakeDb.select = vi.fn(() => ({
    from: () => ({
      where: () => Promise.resolve(opts.actorEmail ? [{ email: opts.actorEmail }] : []),
    }),
  }));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = opts.actor ?? ACTOR_WITH_EXISTING;
    next();
  });
  app.use(
    "/api/companies",
    companyRoutes(fakeDb, undefined, {
      requireCorpEmail: opts.requireCorpEmail ?? false,
    }),
  );
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  createMock = vi.fn();
  findByEmailDomainMock = vi.fn().mockResolvedValue(null);
  ensureMembershipMock = vi.fn().mockResolvedValue({});
});

describe("POST /api/companies — Pro free-mail block (AGE-60 + AGE-104)", () => {
  it.each(["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com"])(
    "rejects ADDITIONAL workspaces from %s with 400 pro_requires_corp_email when requireCorpEmail is on",
    async (domain) => {
      const app = buildApp({
        actorEmail: `alice@${domain}`,
        requireCorpEmail: true,
        actor: ACTOR_WITH_EXISTING,
      });
      const res = await request(app).post("/api/companies").send({ name: "Personal" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("pro_requires_corp_email");
      expect(res.body.error).toContain("company email");
      expect(createMock).not.toHaveBeenCalled();
    },
  );

  it.each(["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com"])(
    "AGE-104: ALLOWS the FIRST workspace from %s (legacy account fallback) when requireCorpEmail is on",
    async (domain) => {
      createMock.mockResolvedValue({
        id: "company-fre",
        name: "Personal",
        budgetMonthlyCents: 0,
        emailDomain: `alice@${domain}`,
      });
      const app = buildApp({
        actorEmail: `alice@${domain}`,
        requireCorpEmail: true,
        actor: ACTOR_NO_COMPANIES,
      });
      const res = await request(app).post("/api/companies").send({ name: "Personal" });

      expect(res.status).toBe(201);
      // companies.create is invoked with (input, allowProSeed) — match by
      // the first arg only via expect.anything() for the trailing flag.
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({ emailDomain: `alice@${domain}` }),
        expect.anything(),
      );
    },
  );

  it("allows corp-domain creator when requireCorpEmail is on (additional workspace)", async () => {
    createMock.mockResolvedValue({
      id: "company-1",
      name: "Acme",
      budgetMonthlyCents: 0,
      emailDomain: "acme.com",
    });
    const app = buildApp({
      actorEmail: "alice@acme.com",
      requireCorpEmail: true,
      actor: ACTOR_WITH_EXISTING,
    });
    const res = await request(app).post("/api/companies").send({ name: "Acme" });

    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalled();
  });

  it("allows free-mail creator when requireCorpEmail is OFF (Free deployment)", async () => {
    createMock.mockResolvedValue({
      id: "company-2",
      name: "Solo",
      budgetMonthlyCents: 0,
      emailDomain: "alice@gmail.com",
    });
    const app = buildApp({
      actorEmail: "alice@gmail.com",
      requireCorpEmail: false,
      actor: ACTOR_WITH_EXISTING,
    });
    const res = await request(app).post("/api/companies").send({ name: "Solo" });

    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalled();
  });

  it("exempts local_implicit board actor even when requireCorpEmail is on", async () => {
    createMock.mockResolvedValue({
      id: "company-3",
      name: "Dev Co",
      budgetMonthlyCents: 0,
      emailDomain: null,
    });
    // local_implicit actors have no userId-keyed email row; pass actorEmail
    // undefined so the select returns []. The route's outer guard skips
    // email lookup entirely for local_implicit anyway.
    const app = buildApp({
      actorEmail: undefined,
      requireCorpEmail: true,
      actor: LOCAL_ACTOR,
    });
    const res = await request(app).post("/api/companies").send({ name: "Dev Co" });

    expect(res.status).toBe(201);
    expect(createMock).toHaveBeenCalled();
  });
});
