import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockCompanyPortabilityService = vi.hoisted(() => ({
  exportBundle: vi.fn(),
  previewExport: vi.fn(),
  previewImport: vi.fn(),
  importBundle: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockFeedbackService = vi.hoisted(() => ({
  listIssueVotesForUser: vi.fn(),
  listFeedbackTraces: vi.fn(),
  getFeedbackTraceById: vi.fn(),
  saveIssueVote: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  agentRunService: vi.fn().mockReturnValue({ recordRun: vi.fn(), monthlyCount: vi.fn(), monthlyCountByAgent: vi.fn() }),
    agentInstructionRefreshService: () => ({ refreshForAgent: vi.fn(), refreshForRole: vi.fn() }),
    ISSUE_LIST_DEFAULT_LIMIT: 50,
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  budgetService: () => mockBudgetService,
  companyPortabilityService: () => mockCompanyPortabilityService,
  companyService: () => mockCompanyService,
  feedbackService: () => mockFeedbackService,
  logActivity: mockLogActivity,
}));

function createCompany() {
  const now = new Date("2026-03-19T02:00:00.000Z");
  return {
    id: "company-1",
    name: "Paperclip",
    description: null,
    status: "active",
    issuePrefix: "PAP",
    issueCounter: 568,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    requireBoardApprovalForNewAgents: false,
    brandColor: "#123456",
    logoAssetId: "11111111-1111-4111-8111-111111111111",
    logoUrl: "/api/assets/11111111-1111-4111-8111-111111111111/content",
    createdAt: now,
    updatedAt: now,
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ companyRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/companies.js")>("../routes/companies.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api/companies", companyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("PATCH /api/companies/:companyId/branding", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/companies.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
  });

  it("rejects non-CEO agent callers", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "engineer",
    });
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/companies/company-1/branding")
      .send({ logoAssetId: "11111111-1111-4111-8111-111111111111" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only CEO agents");
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });

  it("allows CEO agent callers to update branding fields", async () => {
    const company = createCompany();
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      role: "ceo",
    });
    mockCompanyService.update.mockResolvedValue(company);
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/companies/company-1/branding")
      .send({
        logoAssetId: "11111111-1111-4111-8111-111111111111",
        brandColor: "#123456",
      });

    expect(res.status).toBe(200);
    expect(res.body.logoAssetId).toBe(company.logoAssetId);
    expect(mockCompanyService.update).toHaveBeenCalledWith("company-1", {
      logoAssetId: "11111111-1111-4111-8111-111111111111",
      brandColor: "#123456",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        actorType: "agent",
        actorId: "agent-1",
        agentId: "agent-1",
        runId: "run-1",
        action: "company.branding_updated",
        details: {
          logoAssetId: "11111111-1111-4111-8111-111111111111",
          brandColor: "#123456",
        },
      }),
    );
  });

  it("allows board callers to update branding fields", async () => {
    const company = createCompany();
    mockCompanyService.update.mockResolvedValue({
      ...company,
      brandColor: null,
      logoAssetId: null,
      logoUrl: null,
    });
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .patch("/api/companies/company-1/branding")
      .send({ brandColor: null, logoAssetId: null });

    expect(res.status).toBe(200);
    expect(res.body.brandColor ?? null).toBeNull();
    expect(res.body.logoAssetId ?? null).toBeNull();
  });

  /**
   * A CEO agent may manage the colour and the logo. It may not rename the
   * company or rewrite its description — that is the company's identity, and
   * it belongs with the people who set direction.
   *
   * Not hypothetical. Probed on the live uat instance with a real CEO-role
   * agent key: `PATCH /companies/:id {name}` returned 200 and the database read
   * back "RENAMED BY CEO AGENT", and this route returned 200 for a description
   * rewrite. The role check was correct; the FIELD LIST was the hole, because
   * `updateCompanyBrandingSchema` legitimately carries name and description for
   * human callers and was doing double duty as the agent's boundary.
   */
  describe("company identity is not branding", () => {
    function ceoAgent() {
      mockAgentService.getById.mockResolvedValue({ id: "agent-1", companyId: "company-1", role: "ceo" });
      return {
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        source: "agent_key",
        runId: "run-1",
      };
    }

    it("refuses a CEO agent renaming the company", async () => {
      const app = await createApp(ceoAgent());
      const res = await request(app)
        .patch("/api/companies/company-1/branding")
        .send({ name: "RENAMED BY CEO AGENT" });

      expect(res.status).toBe(403);
      // A boundary must say what the rule is. A bare 400 "Validation error"
      // reads as a bug, which is the confusion Gate 1 removed elsewhere.
      expect(String(res.body.error)).toMatch(/cannot change the company's name/i);
      expect(String(res.body.error)).toMatch(/owner, admin or operator/i);
      // And the database must not have been touched at all — a refusal that
      // still writes is the failure mode this whole gate exists for.
      expect(mockCompanyService.update).not.toHaveBeenCalled();
    });

    it("refuses a CEO agent rewriting the description", async () => {
      const app = await createApp(ceoAgent());
      const res = await request(app)
        .patch("/api/companies/company-1/branding")
        .send({ description: "REWRITTEN BY CEO AGENT" });

      expect(res.status).toBe(403);
      expect(mockCompanyService.update).not.toHaveBeenCalled();
    });

    it("refuses a rename smuggled in beside a legitimate colour change", async () => {
      // The one that a field-by-field guard misses. `brandColor` is allowed, so
      // a check that stops at "is any field permitted" lets the name through
      // with it.
      const app = await createApp(ceoAgent());
      const res = await request(app)
        .patch("/api/companies/company-1/branding")
        .send({ brandColor: "#123456", name: "RENAMED BY CEO AGENT" });

      expect(res.status).toBe(403);
      expect(mockCompanyService.update).not.toHaveBeenCalled();
    });

    it("refuses a CEO agent renaming via PATCH /companies/:id too", async () => {
      // The route the live probe hit first. Two doors to the same field; one
      // guarded is not guarded.
      mockCompanyService.getById.mockResolvedValue(createCompany());
      const app = await createApp(ceoAgent());
      const res = await request(app)
        .patch("/api/companies/company-1")
        .send({ name: "RENAMED BY CEO AGENT" });

      expect(res.status).toBe(403);
      expect(mockCompanyService.update).not.toHaveBeenCalled();
    });

    it("still lets a CEO agent set the colour via PATCH /companies/:id", async () => {
      // Control: the route is not simply closed to agents.
      mockCompanyService.getById.mockResolvedValue(createCompany());
      mockCompanyService.update.mockResolvedValue(createCompany());
      const app = await createApp(ceoAgent());
      const res = await request(app)
        .patch("/api/companies/company-1")
        .send({ brandColor: "#123456" });

      expect(res.status).toBe(200);
    });

    it("still lets a board user rename the company here", async () => {
      // The control case. Renaming is not forbidden — it is forbidden TO AN
      // AGENT. Without this a route that refused everyone would pass above.
      const company = createCompany();
      mockCompanyService.update.mockResolvedValue({ ...company, name: "MKThink" });
      const app = await createApp({ type: "board", userId: "user-1", source: "local_implicit" });

      const res = await request(app)
        .patch("/api/companies/company-1/branding")
        .send({ name: "MKThink" });

      expect(res.status).toBe(200);
      expect(mockCompanyService.update).toHaveBeenCalledWith("company-1", { name: "MKThink" });
    });
  });

  it("rejects non-branding fields in the request body", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .patch("/api/companies/company-1/branding")
      .send({
        logoAssetId: "11111111-1111-4111-8111-111111111111",
        status: "archived",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });
});
