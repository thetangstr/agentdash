import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Starting a project is work. Setting the company's direction is not.
 *
 * Project creation used to require `assertCanSetCompanyDirection`, so the only
 * way to let a colleague start a project was to also let them rewrite the
 * company's goals — and `viewer`, the one role that could not, could not create
 * anything either. There was no role in between, which meant the most ordinary
 * thing a contributor does was reachable only by handing them authority over
 * everything.
 *
 * These cases pin the separation: the grant buys the work and not the say-so.
 */

const canUser = vi.hoisted(() => vi.fn(async () => false));
const mockProjectService = vi.hoisted(() => ({
  create: vi.fn(async (_companyId: string, data: Record<string, unknown>) => ({
    id: "project-1",
    companyId: "company-1",
    ...data,
  })),
  createWorkspace: vi.fn(),
  getById: vi.fn(),
  list: vi.fn(async () => []),
}));

vi.mock("../services/index.js", () => ({
  agentRunService: vi.fn().mockReturnValue({ recordRun: vi.fn(), monthlyCount: vi.fn(), monthlyCountByAgent: vi.fn() }),
  agentInstructionRefreshService: () => ({ refreshForAgent: vi.fn(), refreshForRole: vi.fn() }),
  ISSUE_LIST_DEFAULT_LIMIT: 50,
  accessService: () => ({ canUser }),
  projectService: () => mockProjectService,
  secretService: () => ({ list: vi.fn(), resolveMany: vi.fn() }),
  environmentService: () => ({ list: vi.fn(), getById: vi.fn() }),
  workspaceOperationService: () => ({}),
  logActivity: vi.fn(),
}));
vi.mock("../services/verdicts.js", () => ({ verdictsService: () => ({}) }));

async function createApp(actor: Record<string, unknown>) {
  const [{ projectRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/projects.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", projectRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function member(role: string) {
  return {
    type: "board",
    source: "session",
    userId: "user-1",
    companyIds: ["company-1"],
    memberships: [{ companyId: "company-1", membershipRole: role, status: "active" }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  canUser.mockResolvedValue(false);
});

describe("who may create a project", () => {
  /**
   * 2026-08-16, the role collapse: exactly two roles. `admin` sets direction;
   * `member` does the work and owns what they create. The old four-tier model
   * — where the only role without direction authority was refused every write
   * — is gone, and with it the gap these tests used to pin. Legacy role
   * strings still appear in stored rows and older clients; they normalize
   * (owner→admin, operator/viewer→member) and are covered below so the
   * mapping cannot silently change.
   */
  it("refuses a member when the permission lookup says no", async () => {
    // In production a member's role grants include projects:create, so this
    // arises only if the lookup itself denies or fails — but the route's
    // contract is the same either way: lookup false means 403, and the
    // refusal names what is missing.
    canUser.mockResolvedValue(false);
    const res = await request(await createApp(member("member")))
      .post("/api/companies/company-1/projects")
      .send({ name: "Sam's first project" });

    expect(res.status).toBe(403);
    expect(String(res.body.error)).toMatch(/projects:create/);
    expect(mockProjectService.create, "a refusal must not write").not.toHaveBeenCalled();
  });

  it("allows a member with the grant", async () => {
    // The point of the model: work without direction authority.
    canUser.mockResolvedValue(true);
    const res = await request(await createApp(member("member")))
      .post("/api/companies/company-1/projects")
      .send({ name: "Sam's first project" });

    expect(res.status).toBe(201);
    expect(mockProjectService.create).toHaveBeenCalledTimes(1);
  });

  it("allows an admin with no explicit grant", async () => {
    // Direction-holders keep the capability implicitly.
    canUser.mockResolvedValue(false);
    const res = await request(await createApp(member("admin")))
      .post("/api/companies/company-1/projects")
      .send({ name: "Leadership project" });

    expect(res.status).toBe(201);
    expect(canUser, "an admin should not need a permission lookup").not.toHaveBeenCalled();
  });

  it("treats a legacy owner row as admin", async () => {
    // Stored rows may still say "owner" until the data migration runs, and an
    // older client may send it afterwards. It must mean admin, not member.
    canUser.mockResolvedValue(false);
    const res = await request(await createApp(member("owner")))
      .post("/api/companies/company-1/projects")
      .send({ name: "Legacy owner project" });

    expect(res.status).toBe(201);
    expect(canUser).not.toHaveBeenCalled();
  });

  it("treats legacy operator and viewer rows as members", async () => {
    // operator loses its old direction authority; viewer GAINS write access.
    // Both are deliberate — the viewer upgrade was measured to affect only
    // uat test users before this shipped.
    canUser.mockResolvedValue(true);
    for (const legacy of ["operator", "viewer"]) {
      const res = await request(await createApp(member(legacy)))
        .post("/api/companies/company-1/projects")
        .send({ name: `Legacy ${legacy} project` });
      expect(res.status, `${legacy} with the grant`).toBe(201);
    }
  });

  it("refuses an agent even if the permission lookup would say yes", async () => {
    // Agents do not start projects. Stated directly rather than relying on the
    // permission lookup happening to fail.
    canUser.mockResolvedValue(true);
    const res = await request(
      await createApp({ type: "agent", agentId: "agent-1", companyId: "company-1", source: "agent_key", companyIds: ["company-1"] }),
    )
      .post("/api/companies/company-1/projects")
      .send({ name: "Agent project" });

    expect(res.status).toBe(403);
    expect(String(res.body.error)).toMatch(/agents cannot create projects/i);
    expect(mockProjectService.create).not.toHaveBeenCalled();
  });

  it("fails closed when the permission lookup throws", async () => {
    // A lookup that errors must not read as permission granted.
    canUser.mockRejectedValue(new Error("database is down"));
    const res = await request(await createApp(member("contributor")))
      .post("/api/companies/company-1/projects")
      .send({ name: "Should not exist" });

    expect(res.status).toBe(403);
    expect(mockProjectService.create).not.toHaveBeenCalled();
  });

  it("does not grant direction along with the project", async () => {
    // The separation, stated as a property: creating projects must not make
    // someone able to set direction. Asserted against the predicate the goal
    // and mandate routes actually use — including the A1 flip itself: a
    // legacy operator, who COULD set direction until 2026-08-16, now cannot.
    const { canSetCompanyDirection } = await import("../routes/authz.js");
    expect(canSetCompanyDirection({ actor: member("member") } as never, "company-1")).toBe(false);
    expect(canSetCompanyDirection({ actor: member("operator") } as never, "company-1")).toBe(false);
    expect(canSetCompanyDirection({ actor: member("viewer") } as never, "company-1")).toBe(false);
    expect(canSetCompanyDirection({ actor: member("admin") } as never, "company-1")).toBe(true);
    expect(canSetCompanyDirection({ actor: member("owner") } as never, "company-1")).toBe(true);
  });
});
