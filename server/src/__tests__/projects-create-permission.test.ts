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
   * The remaining gap, pinned as a test rather than left as a note.
   *
   * `assertCompanyAccess` refuses a `viewer` ANY non-GET request outright —
   * "Viewer access is read-only" — before this route's own guard is consulted.
   * So `projects:create` cannot currently be reached by the one role that has
   * no direction authority, which is exactly the role a colleague should hold.
   *
   * That makes the role model effectively two-tier: read-only observer, or full
   * participant who can also rewrite the company's goals. There is no
   * contributor in between. Separating project creation from direction, which
   * this file's other cases cover, is necessary for a fix and is not
   * sufficient on its own.
   */
  it("is still blocked for a viewer by the blanket read-only rule", async () => {
    canUser.mockResolvedValue(true);
    const res = await request(await createApp(member("viewer")))
      .post("/api/companies/company-1/projects")
      .send({ name: "Sam's first project" });

    expect(res.status).toBe(403);
    expect(String(res.body.error)).toMatch(/viewer access is read-only/i);
    expect(mockProjectService.create).not.toHaveBeenCalled();
  });

  it("refuses a non-viewer without the grant, and names what is missing", async () => {
    // A refusal has to say what would fix it. `assertCompanyAccess` lets a
    // non-viewer member through, so this route's own guard is what answers.
    canUser.mockResolvedValue(false);
    const res = await request(await createApp(member("contributor")))
      .post("/api/companies/company-1/projects")
      .send({ name: "Sam's first project" });

    expect(res.status).toBe(403);
    expect(String(res.body.error)).toMatch(/projects:create/);
    expect(mockProjectService.create, "a refusal must not write").not.toHaveBeenCalled();
  });

  it("allows a non-direction member WITH the grant", async () => {
    // The point of the change: work without direction authority.
    canUser.mockResolvedValue(true);
    const res = await request(await createApp(member("contributor")))
      .post("/api/companies/company-1/projects")
      .send({ name: "Sam's first project" });

    expect(res.status).toBe(201);
    expect(mockProjectService.create).toHaveBeenCalledTimes(1);
  });

  it("still allows an owner with no explicit grant", async () => {
    // Direction-holders keep the capability implicitly. Nothing an owner could
    // do yesterday may be refused today.
    canUser.mockResolvedValue(false);
    const res = await request(await createApp(member("owner")))
      .post("/api/companies/company-1/projects")
      .send({ name: "Leadership project" });

    expect(res.status).toBe(201);
    expect(canUser, "an owner should not need a permission lookup").not.toHaveBeenCalled();
  });

  it("still allows an operator with no explicit grant", async () => {
    canUser.mockResolvedValue(false);
    const res = await request(await createApp(member("operator")))
      .post("/api/companies/company-1/projects")
      .send({ name: "Operator project" });

    expect(res.status).toBe(201);
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
    // The separation, stated as a property: holding `projects:create` must not
    // make someone able to set direction. Asserted against the predicate the
    // goal and mandate routes actually use.
    const { canSetCompanyDirection } = await import("../routes/authz.js");
    expect(canSetCompanyDirection({ actor: member("viewer") } as never, "company-1")).toBe(false);
    expect(canSetCompanyDirection({ actor: member("operator") } as never, "company-1")).toBe(true);
  });
});
