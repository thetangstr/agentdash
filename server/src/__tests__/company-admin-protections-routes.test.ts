import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Company configuration and destructive actions are an owner/admin decision.
 *
 * Archive, delete, settings, branding and imports into an existing company all
 * ask `assertCompanyAdministrator` — an active owner/admin membership, the local
 * implicit board, or an instance admin. A plain member gets a 403 that names
 * the rule. Exports are owner/admin only too: a bundle carries every agent's
 * instructions and every project and issue, restricted ones included. The
 * CEO-agent paths (branding, colour/logo via PATCH, safe imports, exports) are
 * unchanged.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";

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
  getMembership: vi.fn(),
  canUser: vi.fn(),
}));

const mockCompanyPortabilityService = vi.hoisted(() => ({
  exportBundle: vi.fn(),
  previewExport: vi.fn(),
  previewImport: vi.fn(),
  importBundle: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentRunService: vi.fn().mockReturnValue({ recordRun: vi.fn(), monthlyCount: vi.fn(), monthlyCountByAgent: vi.fn() }),
  agentInstructionRefreshService: () => ({ refreshForAgent: vi.fn(), refreshForRole: vi.fn() }),
  ISSUE_LIST_DEFAULT_LIMIT: 50,
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  budgetService: () => ({ upsertPolicy: vi.fn() }),
  companyPortabilityService: () => mockCompanyPortabilityService,
  companyService: () => mockCompanyService,
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(),
    listFeedbackTraces: vi.fn(),
    getFeedbackTraceById: vi.fn(),
    saveIssueVote: vi.fn(),
  }),
  logActivity: mockLogActivity,
}));

// The spend predicate reads the database; these tests are about authority.
vi.mock("../routes/visibility.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../routes/visibility.js")>();
  return { ...actual, canReadCompanySpend: vi.fn().mockResolvedValue(true) };
});

function company() {
  const now = new Date("2026-11-01T00:00:00.000Z");
  return {
    id: COMPANY,
    name: "Acme",
    description: null,
    status: "active",
    productProfile: "default",
    issuePrefix: "ACM",
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    feedbackDataSharingEnabled: false,
    brandColor: null,
    logoAssetId: null,
    createdAt: now,
    updatedAt: now,
  };
}

function boardUser(userId: string, role: "owner" | "admin" | "member", opts: { instanceAdmin?: boolean } = {}) {
  return {
    type: "board",
    userId,
    source: "session",
    isInstanceAdmin: opts.instanceAdmin ?? false,
    companyIds: [COMPANY],
    memberships: [{ companyId: COMPANY, status: "active", membershipRole: role }],
  };
}

const ACTORS = {
  member: boardUser("member-1", "member"),
  owner: boardUser("owner-1", "owner"),
  admin: boardUser("admin-1", "admin"),
  instanceAdmin: boardUser("instance-admin-1", "member", { instanceAdmin: true }),
  localBoard: { type: "board", userId: "local-board", source: "local_implicit", isInstanceAdmin: true },
};

const ROLE_BY_USER: Record<string, string> = {
  "member-1": "member",
  "owner-1": "owner",
  "admin-1": "admin",
  "instance-admin-1": "member",
};

function ceoAgent() {
  return { type: "agent", agentId: "ceo-1", companyId: COMPANY, source: "agent_key", runId: "run-1" };
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

const importBody = {
  source: { type: "inline", files: { "COMPANY.md": "---\nname: Acme\n---\n" } },
  include: { company: true, agents: true, projects: false, issues: false },
  target: { mode: "existing_company", companyId: COMPANY },
  collisionStrategy: "rename",
};

const ADMINS = ["owner", "admin", "instanceAdmin", "localBoard"] as const;

describe("company owner/admin protections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.getMembership.mockImplementation(async (_companyId: string, _type: string, userId: string) =>
      ROLE_BY_USER[userId] ? { status: "active", membershipRole: ROLE_BY_USER[userId] } : null,
    );
    mockAccessService.canUser.mockResolvedValue(true);
    mockAgentService.getById.mockImplementation(async (id: string) => ({
      id,
      companyId: COMPANY,
      role: id === "ceo-1" ? "ceo" : "engineer",
    }));
    mockCompanyService.getById.mockResolvedValue(company());
    mockCompanyService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...company(),
      ...patch,
    }));
    mockCompanyService.archive.mockResolvedValue({ ...company(), status: "archived" });
    mockCompanyService.remove.mockResolvedValue(company());
    mockCompanyPortabilityService.previewImport.mockResolvedValue({ ok: true });
    mockCompanyPortabilityService.importBundle.mockResolvedValue({
      company: { id: COMPANY, action: "updated" },
      agents: [],
      warnings: [],
    });
    mockCompanyPortabilityService.exportBundle.mockResolvedValue({ rootPath: "acme", files: {}, warnings: [] });
    mockCompanyPortabilityService.previewExport.mockResolvedValue({ rootPath: "acme", files: {}, warnings: [] });
  });

  describe("POST /:companyId/archive", () => {
    it("refuses a member with the plain message and archives nothing", async () => {
      const res = await request(await createApp(ACTORS.member)).post(`/api/companies/${COMPANY}/archive`);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Only owners and admins can archive this company.");
      expect(mockCompanyService.archive).not.toHaveBeenCalled();
    });

    it.each(ADMINS)("lets the %s archive", async (who) => {
      const res = await request(await createApp(ACTORS[who])).post(`/api/companies/${COMPANY}/archive`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockCompanyService.archive).toHaveBeenCalledWith(COMPANY);
    });
  });

  describe("DELETE /:companyId", () => {
    it("refuses a member with the plain message and deletes nothing", async () => {
      const res = await request(await createApp(ACTORS.member)).delete(`/api/companies/${COMPANY}`);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Only owners and admins can delete this company.");
      expect(mockCompanyService.remove).not.toHaveBeenCalled();
    });

    it.each(ADMINS)("lets the %s delete", async (who) => {
      const res = await request(await createApp(ACTORS[who])).delete(`/api/companies/${COMPANY}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockCompanyService.remove).toHaveBeenCalledWith(COMPANY);
    });
  });

  describe("PATCH /:companyId", () => {
    it.each([
      ["a rename", { name: "Renamed" }],
      ["a budget", { budgetMonthlyCents: 100 }],
      ["the hiring toggle", { requireBoardApprovalForNewAgents: true }],
      ["agent visibility", { agentVisibilityDefault: "owner" }],
      ["the product profile", { productProfile: "agentdash_mk" }],
    ])("refuses a member changing %s", async (_label, body) => {
      const res = await request(await createApp(ACTORS.member)).patch(`/api/companies/${COMPANY}`).send(body);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Only owners and admins can change company settings.");
      expect(mockCompanyService.update).not.toHaveBeenCalled();
    });

    it.each(ADMINS)("lets the %s change settings", async (who) => {
      const res = await request(await createApp(ACTORS[who]))
        .patch(`/api/companies/${COMPANY}`)
        .send({ name: "Renamed", newIssuesStartAsTodo: true });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockCompanyService.update).toHaveBeenCalledWith(COMPANY, { name: "Renamed", newIssuesStartAsTodo: true });
    });

    it("keeps the CEO agent's colour-and-logo path unchanged", async () => {
      const app = await createApp(ceoAgent());
      const ok = await request(app).patch(`/api/companies/${COMPANY}`).send({ brandColor: "#123456" });
      expect(ok.status).toBe(200);
      const rename = await request(app).patch(`/api/companies/${COMPANY}`).send({ name: "Renamed" });
      expect(rename.status).toBe(403);
      expect(rename.body.error).toMatch(/cannot change the company's name/);
      // The administrator check is a board-user rule; it is never asked here.
      expect(mockAccessService.getMembership).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /:companyId/branding", () => {
    it("refuses a member with the plain message", async () => {
      const res = await request(await createApp(ACTORS.member))
        .patch(`/api/companies/${COMPANY}/branding`)
        .send({ brandColor: "#123456" });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Only owners and admins can change company settings.");
      expect(mockCompanyService.update).not.toHaveBeenCalled();
    });

    it.each(ADMINS)("lets the %s change branding", async (who) => {
      const res = await request(await createApp(ACTORS[who]))
        .patch(`/api/companies/${COMPANY}/branding`)
        .send({ brandColor: "#123456" });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });

    it("keeps the CEO agent's branding path unchanged", async () => {
      const res = await request(await createApp(ceoAgent()))
        .patch(`/api/companies/${COMPANY}/branding`)
        .send({ brandColor: "#123456" });
      expect(res.status).toBe(200);
      expect(mockAccessService.getMembership).not.toHaveBeenCalled();
    });
  });

  describe("imports into an existing company", () => {
    const routes = [
      ["global preview", "/api/companies/import/preview"],
      ["global apply", "/api/companies/import"],
      ["safe preview", `/api/companies/${COMPANY}/imports/preview`],
      ["safe apply", `/api/companies/${COMPANY}/imports/apply`],
    ] as const;

    it.each(routes)("refuses a member on the %s route", async (_label, path) => {
      const res = await request(await createApp(ACTORS.member)).post(path).send(importBody);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Only owners and admins can import into this company.");
      expect(mockCompanyPortabilityService.previewImport).not.toHaveBeenCalled();
      expect(mockCompanyPortabilityService.importBundle).not.toHaveBeenCalled();
    });

    for (const who of ADMINS) {
      it.each(routes)(`lets the ${who} use the %s route`, async (_label, path) => {
        const res = await request(await createApp(ACTORS[who])).post(path).send(importBody);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      });
    }

    it.each(routes.filter(([label]) => label.startsWith("safe")))(
      "keeps the CEO agent on the %s route",
      async (_label, path) => {
        const res = await request(await createApp(ceoAgent())).post(path).send(importBody);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(mockAccessService.getMembership).not.toHaveBeenCalled();
      },
    );
  });

  describe("exports", () => {
    const exportBody = { include: { company: true, agents: true, projects: true, issues: true } };
    const routes = [
      ["legacy export", `/api/companies/${COMPANY}/export`],
      ["export preview", `/api/companies/${COMPANY}/exports/preview`],
      ["export", `/api/companies/${COMPANY}/exports`],
    ] as const;

    it.each(routes)("refuses a member on the %s route and builds nothing", async (_label, path) => {
      const res = await request(await createApp(ACTORS.member)).post(path).send(exportBody);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Only owners and admins can export this company.");
      expect(mockCompanyPortabilityService.exportBundle).not.toHaveBeenCalled();
      expect(mockCompanyPortabilityService.previewExport).not.toHaveBeenCalled();
    });

    for (const who of ADMINS) {
      it.each(routes)(`lets the ${who} use the %s route`, async (_label, path) => {
        const res = await request(await createApp(ACTORS[who])).post(path).send(exportBody);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      });
    }

    it.each(routes)("keeps the CEO agent on the %s route", async (_label, path) => {
      const res = await request(await createApp(ceoAgent())).post(path).send(exportBody);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(mockAccessService.getMembership).not.toHaveBeenCalled();
    });
  });
});
