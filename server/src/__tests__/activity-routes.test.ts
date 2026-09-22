import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockActivityService = vi.hoisted(() => ({
  list: vi.fn(),
  forIssue: vi.fn(),
  runsForIssue: vi.fn(),
  issuesForRun: vi.fn(),
  create: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  getRun: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));

vi.mock("../services/activity.js", () => ({
  activityService: () => mockActivityService,
  normalizeActivityLimit: (limit: number | undefined) => {
    if (!Number.isFinite(limit)) return 100;
    return Math.max(1, Math.min(500, Math.floor(limit ?? 100)));
  },
  normalizeIssueRunsLimit: (limit: number | undefined) => {
    if (!Number.isFinite(limit)) return 100;
    return Math.max(1, Math.min(500, Math.floor(limit ?? 100)));
  },
}));

vi.mock("../services/index.js", () => ({
  agentRunService: vi.fn().mockReturnValue({ recordRun: vi.fn(), monthlyCount: vi.fn(), monthlyCountByAgent: vi.fn() }),
    agentInstructionRefreshService: () => ({ refreshForAgent: vi.fn(), refreshForRole: vi.fn() }),
    ISSUE_LIST_DEFAULT_LIMIT: 50,
  issueService: () => mockIssueService,
  heartbeatService: () => mockHeartbeatService,
}));

async function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "user-1",
    companyIds: ["company-1"],
    source: "session",
    isInstanceAdmin: false,
  },
) {
  vi.resetModules();
  const [{ errorHandler }, { activityRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/activity.js") as Promise<typeof import("../routes/activity.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
    };
    next();
  });
  app.use("/api", activityRoutes({} as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

describe.sequential("activity routes", () => {
  beforeEach(() => {
    for (const mock of Object.values(mockActivityService)) mock.mockReset();
    for (const mock of Object.values(mockHeartbeatService)) mock.mockReset();
    for (const mock of Object.values(mockIssueService)) mock.mockReset();
  });

  it("limits company activity lists by default", async () => {
    mockActivityService.list.mockResolvedValue([]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/companies/company-1/activity"));

    expect(res.status).toBe(200);
    expect(mockActivityService.list).toHaveBeenCalledWith({
      companyId: "company-1",
      agentId: undefined,
      entityType: undefined,
      entityId: undefined,
      limit: 100,
    });
  });

  it("caps requested company activity list limits", async () => {
    mockActivityService.list.mockResolvedValue([]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/companies/company-1/activity?limit=5000&entityType=issue"),
    );

    expect(res.status).toBe(200);
    expect(mockActivityService.list).toHaveBeenCalledWith({
      companyId: "company-1",
      agentId: undefined,
      entityType: "issue",
      entityId: undefined,
      limit: 500,
    });
  });

  it("resolves issue identifiers before loading runs", async () => {
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-uuid-1",
      companyId: "company-1",
    });
    mockActivityService.runsForIssue.mockResolvedValue([
      {
        runId: "run-1",
        adapterType: "codex_local",
      },
    ]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/issues/PAP-475/runs"));

    expect(res.status).toBe(200);
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("PAP-475");
    expect(mockIssueService.getById).not.toHaveBeenCalled();
    expect(mockActivityService.runsForIssue).toHaveBeenCalledWith("company-1", "issue-uuid-1", {
      limit: 100,
      offset: 0,
    });
    expect(res.body).toEqual([{ runId: "run-1", adapterType: "codex_local" }]);
  });

  it("bounds the default issue run list to 100 runs", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-uuid-1",
      companyId: "company-1",
    });
    mockActivityService.runsForIssue.mockResolvedValue([]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/issues/issue-uuid-1/runs"));

    expect(res.status).toBe(200);
    expect(mockActivityService.runsForIssue).toHaveBeenCalledWith("company-1", "issue-uuid-1", {
      limit: 100,
      offset: 0,
    });
  });

  it("passes bounded limit and offset filters to the issue run list", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-uuid-1",
      companyId: "company-1",
    });
    mockActivityService.runsForIssue.mockResolvedValue([]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/issues/issue-uuid-1/runs?limit=25&offset=50"),
    );

    expect(res.status).toBe(200);
    expect(mockActivityService.runsForIssue).toHaveBeenCalledWith("company-1", "issue-uuid-1", {
      limit: 25,
      offset: 50,
    });
  });

  it("caps oversized issue run list limits", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-uuid-1",
      companyId: "company-1",
    });
    mockActivityService.runsForIssue.mockResolvedValue([]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/issues/issue-uuid-1/runs?limit=99999"),
    );

    expect(res.status).toBe(200);
    expect(mockActivityService.runsForIssue).toHaveBeenCalledWith("company-1", "issue-uuid-1", {
      limit: 500,
      offset: 0,
    });
  });

  it("rejects non-numeric issue run list paging parameters", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-uuid-1",
      companyId: "company-1",
    });

    const app = await createApp();
    const badLimit = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/issues/issue-uuid-1/runs?limit=abc"),
    );
    expect(badLimit.status).toBe(400);

    const badOffset = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/issues/issue-uuid-1/runs?offset=-3"),
    );
    expect(badOffset.status).toBe(400);
    expect(mockActivityService.runsForIssue).not.toHaveBeenCalled();
  });

  it("serves issue run payloads through the redacting service without re-exposing context snapshots", async () => {
    // Redaction itself is proven by the DB-backed activity-service tests
    // (summarizeHeartbeatRunContextSnapshot allow-list). Here we pin the
    // route contract: the payload served to clients is exactly the
    // service-returned, already-redacted record.
    const summarizedSnapshot = { issueId: "issue-uuid-1", wakeReason: "retry_failed_run" };
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-uuid-1",
      companyId: "company-1",
    });
    mockActivityService.runsForIssue.mockResolvedValue([
      {
        runId: "run-1",
        status: "failed",
        adapterType: "hermes_paperclip",
        contextSnapshot: summarizedSnapshot,
      },
    ]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/issues/PAP-475/runs"));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].contextSnapshot).toEqual(summarizedSnapshot);
    expect(res.body[0]).not.toHaveProperty("stdoutExcerpt");
    expect(res.body[0]).not.toHaveProperty("stderrExcerpt");
    expect(res.body[0]).not.toHaveProperty("error");
    expect(res.body[0]).not.toHaveProperty("adapterConfig");
  });

  it("requires company access before creating activity events", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-2/activity")
      .send({
        actorId: "user-1",
        action: "test.event",
        entityType: "issue",
        entityId: "issue-1",
      }));

    expect(res.status).toBe(403);
    expect(mockActivityService.create).not.toHaveBeenCalled();
  });

  it("requires company access before listing issues for another company's run", async () => {
    mockHeartbeatService.getRun.mockResolvedValue({
      id: "run-2",
      companyId: "company-2",
    });

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/run-2/issues"));

    expect(res.status).toBe(403);
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });

  it("rejects anonymous heartbeat run issue lookups before run existence checks", async () => {
    const app = await createApp({ type: "none", source: "none" });
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/heartbeat-runs/missing-run/issues"));

    expect(res.status).toBe(401);
    expect(mockHeartbeatService.getRun).not.toHaveBeenCalled();
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });
});
