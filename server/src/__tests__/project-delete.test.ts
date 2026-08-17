import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Deleting a project was impossible for any project that had ever held an issue.
 *
 * `issues.project_id` carries no cascade, so `delete from projects` raised a
 * foreign-key violation and the route turned it into
 * `500 Internal server error`. Nothing in that response named the cause, the
 * blocking table, or a way forward -- it read as a crash. Found by trying to
 * clear test data off the real workspace the night before a client install,
 * which is the wrong moment to discover a basic verb does not work.
 *
 * Two things are pinned, and the second matters more:
 *
 *   1. A project with issues refuses with 409 and says how many.
 *   2. It deletes them only when the caller explicitly asks.
 *
 * Cascading by default would be the easy fix and the wrong one: a project is a
 * container for work, and one click should not take a board's worth of issues,
 * comments and approval history with it.
 */

const canUser = vi.hoisted(() => vi.fn(async () => true));
const STATE = vi.hoisted(() => ({ issueCount: 0 }));
const PROJECT = vi.hoisted(() => ({
  current: {
    id: "project-1",
    companyId: "company-1",
    name: "Board pack",
    createdByUserId: "titus" as string | null,
  },
}));
const mockProjectService = vi.hoisted(() => ({
  create: vi.fn(),
  createWorkspace: vi.fn(),
  getById: vi.fn(async () => PROJECT.current),
  update: vi.fn(),
  countIssues: vi.fn(async () => STATE.issueCount),
  remove: vi.fn(async () => PROJECT.current),
  list: vi.fn(async () => []),
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

async function createApp() {
  const [{ projectRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/projects.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      source: "session",
      userId: "titus",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "admin", status: "active" }],
    };
    next();
  });
  app.use("/api", projectRoutes({} as any));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  canUser.mockResolvedValue(true);
  STATE.issueCount = 0;
  PROJECT.current = {
    id: "project-1",
    companyId: "company-1",
    name: "Board pack",
    createdByUserId: "titus",
  };
});

describe("DELETE /projects/:id", () => {
  it("refuses with 409 — not 500 — when the project still holds issues", async () => {
    STATE.issueCount = 9;
    const res = await request(await createApp()).delete("/api/projects/project-1");

    expect(res.status).toBe(409);
    expect(res.body.issueCount).toBe(9);
    // The message must be actionable. A 409 saying only "conflict" would be
    // the same dead end as the 500 it replaced.
    expect(res.body.error).toMatch(/withIssues=true/);
    expect(mockProjectService.remove, "nothing may be deleted on a refusal").not.toHaveBeenCalled();
  });

  it("deletes the project and its issues when asked explicitly", async () => {
    STATE.issueCount = 9;
    const res = await request(await createApp()).delete("/api/projects/project-1?withIssues=true");

    expect(res.status).toBe(200);
    expect(mockProjectService.remove).toHaveBeenCalledWith("project-1", { withIssues: true });
  });

  it("still deletes an empty project without the flag", async () => {
    // The guard must not become "you can never delete anything".
    STATE.issueCount = 0;
    const res = await request(await createApp()).delete("/api/projects/project-1");

    expect(res.status).toBe(200);
    expect(mockProjectService.remove).toHaveBeenCalledWith("project-1", { withIssues: false });
  });
});
