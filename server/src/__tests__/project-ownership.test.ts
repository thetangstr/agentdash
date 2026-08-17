import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A4 (2026-08-16): editing follows ownership. You change what you created;
 * an admin changes anything.
 *
 * These routes required direction authority until tonight, which under the
 * two-role model meant a member could CREATE a project they could never
 * edit or delete. Each case here is falsified by reverting the guard: put
 * `assertCanSetCompanyDirection` back and "creator edits own project" fails.
 */

const canUser = vi.hoisted(() => vi.fn(async () => false));
const PROJECT = vi.hoisted(() => ({
  current: {
    id: "project-1",
    companyId: "company-1",
    name: "Sam's project",
    createdByUserId: "sam" as string | null,
  },
}));
const mockProjectService = vi.hoisted(() => ({
  create: vi.fn(async (_companyId: string, data: Record<string, unknown>) => ({
    id: "project-1",
    companyId: "company-1",
    ...data,
  })),
  createWorkspace: vi.fn(),
  getById: vi.fn(async () => PROJECT.current),
  update: vi.fn(async (_id: string, body: Record<string, unknown>) => ({
    ...PROJECT.current,
    ...body,
  })),
  remove: vi.fn(async () => PROJECT.current),
  list: vi.fn(async () => []),
  // agents resolve project references by shortname before the guard runs
  resolveByReference: vi.fn(async () => ({ ambiguous: false, project: PROJECT.current })),
}));

vi.mock("../services/index.js", () => ({
  agentRunService: vi.fn().mockReturnValue({ recordRun: vi.fn(), monthlyCount: vi.fn(), monthlyCountByAgent: vi.fn() }),
  agentInstructionRefreshService: () => ({ refreshForAgent: vi.fn(), refreshForRole: vi.fn() }),
  ISSUE_LIST_DEFAULT_LIMIT: 50,
  accessService: () => ({ canUser }),
  projectService: () => mockProjectService,
  secretService: () => ({ list: vi.fn(), resolveMany: vi.fn(), normalizeEnvBindingsForPersistence: vi.fn(async (_c: string, v: unknown) => v) }),
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

function member(role: string, userId: string) {
  return {
    type: "board",
    source: "session",
    userId,
    companyIds: ["company-1"],
    memberships: [{ companyId: "company-1", membershipRole: role, status: "active" }],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  canUser.mockResolvedValue(false);
  PROJECT.current = {
    id: "project-1",
    companyId: "company-1",
    name: "Sam's project",
    createdByUserId: "sam",
  };
});

describe("project ownership", () => {
  it("records the actor as creator on create — never the body", async () => {
    canUser.mockResolvedValue(true);
    const res = await request(await createApp(member("member", "sam")))
      .post("/api/companies/company-1/projects")
      .send({ name: "New project", createdByUserId: "someone-else" });

    expect(res.status).toBe(201);
    const passed = mockProjectService.create.mock.calls[0][1] as Record<string, unknown>;
    expect(passed.createdByUserId, "the body must not choose the owner").toBe("sam");
  });

  it("lets the creator edit their own project", async () => {
    const res = await request(await createApp(member("member", "sam")))
      .patch("/api/projects/project-1")
      .send({ description: "updated by its creator" });

    expect(res.status).toBe(200);
    expect(mockProjectService.update).toHaveBeenCalledTimes(1);
  });

  it("refuses another member, and says who could", async () => {
    const res = await request(await createApp(member("member", "megan")))
      .patch("/api/projects/project-1")
      .send({ description: "someone else's edit" });

    expect(res.status).toBe(403);
    expect(String(res.body.error)).toMatch(/creator or an admin/i);
    expect(mockProjectService.update).not.toHaveBeenCalled();
  });

  it("lets an admin edit anything", async () => {
    const res = await request(await createApp(member("admin", "titus")))
      .patch("/api/projects/project-1")
      .send({ description: "admin edit" });

    expect(res.status).toBe(200);
  });

  it("lets the creator delete their own project; refuses another member", async () => {
    expect(
      (await request(await createApp(member("member", "sam"))).delete("/api/projects/project-1")).status,
    ).toBe(200);
    expect(
      (await request(await createApp(member("member", "megan"))).delete("/api/projects/project-1")).status,
    ).toBe(403);
  });

  it("falls back to admin-only when no creator is recorded", async () => {
    // Pre-backfill rows and anything created before tonight: fail toward the
    // stricter rule. A missing owner must never read as "anyone may edit".
    PROJECT.current.createdByUserId = null;
    expect(
      (await request(await createApp(member("member", "sam")))
        .patch("/api/projects/project-1")
        .send({ description: "x" })).status,
    ).toBe(403);
    expect(
      (await request(await createApp(member("admin", "titus")))
        .patch("/api/projects/project-1")
        .send({ description: "x" })).status,
    ).toBe(200);
  });

  it("refuses an agent even for a project with its company", async () => {
    const res = await request(
      await createApp({ type: "agent", agentId: "agent-1", companyId: "company-1", source: "agent_key", companyIds: ["company-1"] }),
    )
      .patch("/api/projects/project-1")
      .send({ description: "agent edit" });

    expect(res.status).toBe(403);
    expect(String(res.body.error)).toMatch(/agents cannot modify/i);
  });
});
