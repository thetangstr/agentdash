// AgentDash-MK: an invite code is what grants the agentdash_mk profile.
//
// Two problems this closes, found by the 2026-07-31 feature inventory:
//
// 1. There was NO in-product path to an MK workspace. `productProfile` is
//    accepted by `createCompanySchema`, but nothing in the UI sends it, so a
//    design partner who signs up lands in a default-profile workspace where
//    every MK surface 404s by design. They cannot reach the product.
//
// 2. `POST /api/companies` accepted `productProfile: "agentdash_mk"` from ANY
//    authenticated board user with no gate at all. MK was not opt-in; it was
//    simply unadvertised, which is not the same thing.
//
// The gate applies only in `authenticated` deployments. `local_trusted` is the
// founder's own machine and the mode the e2e suite runs in — gating it there
// would break the acceptance specs, which create MK companies over raw HTTP by
// design.

import express from "express";
import request from "supertest";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { companyRoutes } from "../routes/companies.js";
import { errorHandler } from "../middleware/error-handler.js";

const creator = { id: "user-1", email: "partner@designco.com" };

const fakeDb = {
  select: vi.fn(() => ({
    from: () => ({
      where: () => Promise.resolve([{ email: creator.email }]),
    }),
  })),
} as any;

let createMock: ReturnType<typeof vi.fn>;
let getByIdMock: ReturnType<typeof vi.fn>;
let updateMock: ReturnType<typeof vi.fn>;
let getMembershipMock: ReturnType<typeof vi.fn>;

vi.mock("../services/index.js", () => ({
  agentRunService: vi.fn().mockReturnValue({
    recordRun: vi.fn(),
    monthlyCount: vi.fn(),
    monthlyCountByAgent: vi.fn(),
  }),
  agentInstructionRefreshService: () => ({ refreshForAgent: vi.fn(), refreshForRole: vi.fn() }),
  ISSUE_LIST_DEFAULT_LIMIT: 50,
  companyService: () => ({
    hasActiveCompany: vi.fn().mockResolvedValue(false),
    list: vi.fn().mockResolvedValue([]),
    stats: vi.fn().mockResolvedValue({}),
    getById: (...args: unknown[]) => getByIdMock(...args),
    create: (...args: unknown[]) => createMock(...args),
    findByEmailDomain: vi.fn().mockResolvedValue(null),
    update: (...args: unknown[]) => updateMock(...args),
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
    ensureMembership: vi.fn().mockResolvedValue({}),
    setPrincipalPermission: vi.fn().mockResolvedValue(undefined),
    getMembership: (...args: unknown[]) => getMembershipMock(...args),
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

function buildApp(deploymentMode: string, companyIds: string[] = []) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: creator.id,
      companyIds,
      isInstanceAdmin: false,
      source: deploymentMode === "local_trusted" ? "local_implicit" : "session",
    };
    next();
  });
  app.use("/api/companies", companyRoutes(fakeDb, undefined, { deploymentMode }));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  createMock = vi.fn().mockResolvedValue({
    id: "company-1",
    name: "DesignCo",
    budgetMonthlyCents: 0,
    emailDomain: "designco.com",
    productProfile: "agentdash_mk",
  });
  // The workspace being PATCHed starts on the default profile — the exact state
  // every wizard-created workspace is in, and the one an upgrade would target.
  getByIdMock = vi.fn().mockResolvedValue({
    id: "company-1",
    name: "DesignCo",
    productProfile: "default",
    feedbackDataSharingEnabled: false,
  });
  updateMock = vi.fn().mockResolvedValue({
    id: "company-1",
    name: "DesignCo",
    productProfile: "agentdash_mk",
  });
  // An owner, so the role check passes and the test exercises the code gate
  // rather than stopping at authority.
  getMembershipMock = vi.fn().mockResolvedValue({ status: "active", membershipRole: "owner" });
  process.env.AGENTDASH_MK_INVITE_CODES = "PARTNER-ALPHA,PARTNER-BETA";
});

afterEach(() => {
  delete process.env.AGENTDASH_MK_INVITE_CODES;
});

describe("agentdash_mk profile is granted by invite code", () => {
  it("creates an MK workspace when the caller presents a valid code", async () => {
    // The whole point: this is the in-product path that did not exist. A design
    // partner with a code lands in the product we actually built.
    const res = await request(buildApp("authenticated"))
      .post("/api/companies")
      .send({ name: "DesignCo", productProfile: "agentdash_mk", inviteCode: "PARTNER-ALPHA" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(createMock.mock.calls[0][0]).toMatchObject({ productProfile: "agentdash_mk" });
  });

  it("accepts any configured code, not just the first", async () => {
    const res = await request(buildApp("authenticated"))
      .post("/api/companies")
      .send({ name: "DesignCo", productProfile: "agentdash_mk", inviteCode: "PARTNER-BETA" });

    expect(res.status).toBe(201);
  });

  it("refuses an MK workspace with no code, and creates nothing", async () => {
    // Before this gate, any authenticated user could self-select the profile.
    const res = await request(buildApp("authenticated"))
      .post("/api/companies")
      .send({ name: "DesignCo", productProfile: "agentdash_mk" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("mk_invite_code_required");
    expect(createMock, "a company was created despite the refusal").not.toHaveBeenCalled();
  });

  it("refuses a wrong code, and creates nothing", async () => {
    const res = await request(buildApp("authenticated"))
      .post("/api/companies")
      .send({ name: "DesignCo", productProfile: "agentdash_mk", inviteCode: "GUESSED" });

    expect(res.status).toBe(403);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("refuses when no codes are configured at all", async () => {
    // Fail closed: an operator who never set the env var has not opted in to
    // handing out MK workspaces.
    delete process.env.AGENTDASH_MK_INVITE_CODES;
    const res = await request(buildApp("authenticated"))
      .post("/api/companies")
      .send({ name: "DesignCo", productProfile: "agentdash_mk", inviteCode: "PARTNER-ALPHA" });

    expect(res.status).toBe(403);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("leaves ordinary default-profile signup completely alone", async () => {
    // The gate must be invisible to everyone who is not asking for MK. No code,
    // no profile, no change.
    const res = await request(buildApp("authenticated"))
      .post("/api/companies")
      .send({ name: "DesignCo" });

    expect(res.status).toBe(201);
    expect(createMock.mock.calls[0][0].productProfile).toBeUndefined();
  });

  it("does not gate local_trusted, so dev and the e2e acceptance specs still work", async () => {
    // tests/e2e/agentdash-mk-*.spec.ts create MK companies over raw HTTP with
    // no code, against a local_trusted server. Gating that mode would break the
    // acceptance suite to protect a machine that has no untrusted callers.
    delete process.env.AGENTDASH_MK_INVITE_CODES;
    const res = await request(buildApp("local_trusted"))
      .post("/api/companies")
      .send({ name: "DesignCo", productProfile: "agentdash_mk" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(createMock.mock.calls[0][0]).toMatchObject({ productProfile: "agentdash_mk" });
  });

  it("never echoes the invite code back to the caller", async () => {
    const res = await request(buildApp("authenticated"))
      .post("/api/companies")
      .send({ name: "DesignCo", productProfile: "agentdash_mk", inviteCode: "PARTNER-ALPHA" });

    expect(JSON.stringify(res.body)).not.toContain("PARTNER-ALPHA");
  });

  it("does not pass the invite code through to company creation", async () => {
    // The code is an authorization input, not company data. Persisting it would
    // put a shared secret in a row that gets exported by company portability.
    await request(buildApp("authenticated"))
      .post("/api/companies")
      .send({ name: "DesignCo", productProfile: "agentdash_mk", inviteCode: "PARTNER-ALPHA" });

    expect(createMock.mock.calls[0][0].inviteCode).toBeUndefined();
  });
});

/**
 * The same gate on update — because without it the create-time gate above was
 * decorative.
 *
 * `updateCompanySchema` extends `createCompanySchema.partial()`, so PATCH always
 * accepted `productProfile`, and the route checked only that the caller was an
 * owner or admin. An owner refused the profile at creation could therefore
 * create the workspace with a name, then immediately PATCH the profile in. Role
 * answers "may this person configure this company", which is a different
 * question from "is this workspace entitled to this profile" — and only the
 * second is what a code grants.
 */
describe("agentdash_mk profile cannot be granted by update either", () => {
  const patch = (body: unknown, mode = "authenticated") =>
    request(buildApp(mode, ["company-1"])).patch("/api/companies/company-1").send(body);

  it("upgrades a default workspace when a valid code is presented", async () => {
    // The legitimate path: this is how an existing wizard-created workspace
    // becomes an MK one without being recreated from scratch.
    const res = await patch({ productProfile: "agentdash_mk", inviteCode: "PARTNER-ALPHA" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(updateMock.mock.calls[0][1]).toMatchObject({ productProfile: "agentdash_mk" });
  });

  it("refuses the upgrade with no code, and updates nothing", async () => {
    const res = await patch({ productProfile: "agentdash_mk" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("mk_invite_code_required");
    expect(updateMock, "the company was updated despite the refusal").not.toHaveBeenCalled();
  });

  it("refuses a wrong code, and updates nothing", async () => {
    const res = await patch({ productProfile: "agentdash_mk", inviteCode: "GUESSED" });

    expect(res.status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("refuses when no codes are configured at all", async () => {
    delete process.env.AGENTDASH_MK_INVITE_CODES;
    const res = await patch({ productProfile: "agentdash_mk", inviteCode: "PARTNER-ALPHA" });

    expect(res.status).toBe(403);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("never persists the invite code onto the company row", async () => {
    // Update accepted `inviteCode` and, unlike create, did not strip it — so it
    // flowed into the update payload. Same shared secret, same export path.
    await patch({ productProfile: "agentdash_mk", inviteCode: "PARTNER-ALPHA" });

    expect(updateMock.mock.calls[0][1].inviteCode).toBeUndefined();
  });

  it("never echoes the invite code back to the caller", async () => {
    const res = await patch({ productProfile: "agentdash_mk", inviteCode: "PARTNER-ALPHA" });

    expect(JSON.stringify(res.body)).not.toContain("PARTNER-ALPHA");
  });

  it("leaves updates that do not touch the profile completely alone", async () => {
    // The gate must be invisible to the ordinary case: renaming a company, or
    // any other edit, must not start demanding a code.
    const res = await patch({ name: "DesignCo Renamed" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(updateMock).toHaveBeenCalled();
  });

  it("allows re-sending the profile a workspace already has, with no code", async () => {
    // Idempotent writes are not grants. A client that PATCHes the whole company
    // object back must not be refused for a profile that is not changing.
    getByIdMock = vi.fn().mockResolvedValue({
      id: "company-1",
      name: "DesignCo",
      productProfile: "agentdash_mk",
      feedbackDataSharingEnabled: false,
    });

    const res = await patch({ productProfile: "agentdash_mk" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("allows downgrading to default with no code", async () => {
    // Giving up an entitlement needs no entitlement check.
    getByIdMock = vi.fn().mockResolvedValue({
      id: "company-1",
      name: "DesignCo",
      productProfile: "agentdash_mk",
      feedbackDataSharingEnabled: false,
    });

    const res = await patch({ productProfile: "default" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("does not gate local_trusted, matching the create path", async () => {
    delete process.env.AGENTDASH_MK_INVITE_CODES;
    const res = await patch({ productProfile: "agentdash_mk" }, "local_trusted");

    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});
