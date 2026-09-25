// AgentDash (security): the public PATCH route must not let callers repoint an
// execution workspace's on-disk location or forge runtime ownership, because
// archive cleanup recursively deletes that location for runtime-created
// `local_fs` workspaces.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  getCloseReadiness: vi.fn(),
}));
const mockCleanupExecutionWorkspaceArtifacts = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => ({ canUser: async () => true }),
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  logActivity: vi.fn(),
  workspaceOperationService: () => ({ createRecorder: () => null }),
}));

vi.mock("../services/workspace-runtime.js", () => ({
  buildWorkspaceRuntimeDesiredStatePatch: vi.fn(),
  cleanupExecutionWorkspaceArtifacts: mockCleanupExecutionWorkspaceArtifacts,
  ensurePersistedExecutionWorkspaceAvailable: vi.fn(),
  listConfiguredRuntimeServiceEntries: vi.fn(),
  runWorkspaceJobForControl: vi.fn(),
  startRuntimeServicesForWorkspaceControl: vi.fn(),
  stopRuntimeServicesForExecutionWorkspace: vi.fn(),
}));

const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";

function buildWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKSPACE_ID,
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    sourceIssueId: null,
    mode: "isolated_workspace",
    strategyType: "project_primary",
    name: "Workspace",
    status: "active",
    cwd: "/managed/workspaces/agent-1/ws",
    repoUrl: null,
    baseRef: "main",
    branchName: "feature/test",
    providerType: "local_fs",
    providerRef: "/managed/workspaces/agent-1/ws",
    lastUsedAt: new Date(),
    openedAt: new Date(),
    closedAt: null,
    cleanupEligibleAt: null,
    cleanupReason: null,
    config: null,
    metadata: { createdByRuntime: false, source: "project_primary" },
    runtimeServices: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ executionWorkspaceRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/execution-workspaces.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", executionWorkspaceRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const boardMember = {
  type: "board",
  userId: "user-1",
  source: "session",
  isInstanceAdmin: false,
  companyIds: ["company-1"],
};
const agentKey = {
  type: "agent",
  agentId: "agent-1",
  companyId: "company-1",
  source: "agent_key",
  runId: "run-1",
};

describe("execution workspace PATCH: runtime-owned path fields", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecutionWorkspaceService.getById.mockResolvedValue(buildWorkspace());
    mockExecutionWorkspaceService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) =>
      buildWorkspace(patch));
  });

  it.each([
    ["cwd", { cwd: "/Users/victim/important" }],
    ["providerRef", { providerRef: "/Users/victim/important" }],
    ["branchName", { branchName: "main" }],
    ["cwd cleared", { cwd: null }],
  ])("rejects a board member changing %s", async (_label, body) => {
    const app = await createApp(boardMember);
    const res = await request(app).patch(`/api/execution-workspaces/${WORKSPACE_ID}`).send(body);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/managed by the runtime/);
    expect(mockExecutionWorkspaceService.update).not.toHaveBeenCalled();
  });

  it("rejects an agent key repointing cwd and providerRef", async () => {
    const app = await createApp(agentKey);
    const res = await request(app)
      .patch(`/api/execution-workspaces/${WORKSPACE_ID}`)
      .send({ cwd: "/", providerRef: "/" });
    expect(res.status).toBe(403);
    expect(mockExecutionWorkspaceService.update).not.toHaveBeenCalled();
  });

  it("rejects a path change bundled with an archive request, before any cleanup runs", async () => {
    const app = await createApp(boardMember);
    const res = await request(app)
      .patch(`/api/execution-workspaces/${WORKSPACE_ID}`)
      .send({ status: "archived", providerRef: "/Users/victim" });
    expect(res.status).toBe(403);
    expect(mockCleanupExecutionWorkspaceArtifacts).not.toHaveBeenCalled();
  });

  it("accepts echoing the current path values back unchanged (UI form round-trip)", async () => {
    const app = await createApp(boardMember);
    const current = buildWorkspace();
    const res = await request(app)
      .patch(`/api/execution-workspaces/${WORKSPACE_ID}`)
      .send({ name: "Renamed", cwd: current.cwd, providerRef: current.providerRef, branchName: current.branchName });
    expect(res.status).toBe(200);
    const patch = mockExecutionWorkspaceService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(patch).toEqual({ name: "Renamed" });
  });

  it("ignores a forged metadata.createdByRuntime and keeps the stored ownership markers", async () => {
    const app = await createApp(boardMember);
    const res = await request(app)
      .patch(`/api/execution-workspaces/${WORKSPACE_ID}`)
      .send({ metadata: { createdByRuntime: true, source: "task_session", note: "hello" } });
    expect(res.status).toBe(200);
    const patch = mockExecutionWorkspaceService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(patch.metadata).toEqual({ createdByRuntime: false, source: "project_primary", note: "hello" });
  });

  it("does not let a caller add createdByRuntime to a workspace that never had it", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValue(buildWorkspace({ metadata: null }));
    const app = await createApp(boardMember);
    const res = await request(app)
      .patch(`/api/execution-workspaces/${WORKSPACE_ID}`)
      .send({ metadata: { createdByRuntime: true } });
    expect(res.status).toBe(200);
    const patch = mockExecutionWorkspaceService.update.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(patch.metadata).toEqual({});
    expect((patch.metadata as Record<string, unknown>).createdByRuntime).toBeUndefined();
  });
});
