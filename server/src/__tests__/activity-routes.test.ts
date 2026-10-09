import express from "express";
import request from "supertest";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Document access (slice 6b): the steward-only run rule reads the feature
// flag and stewardships from the db; it is exercised against a real database
// in document-run-protection.test.ts. Here: flag off, everything readable.
vi.mock("../routes/document-run-access.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../routes/document-run-access.js")>()),
  documentRunAccess: () => ({
    documentAccessEnabled: async () => false,
    currentStewardUserId: async () => null,
    canReadRunContent: async () => true,
    assertRunContentReadable: async () => undefined,
    readableAgentIds: async () => null,
  }),
}));

// GH #830: issue, run and workspace routes run the A5 project-visibility
// guards against the db. They are exercised against a real database in
// project-visibility.test.ts; this suite's stub db cannot answer them.
vi.mock("../routes/visibility.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../routes/visibility.js")>()),
  assertIssueIdVisible: vi.fn(async () => undefined),
  assertWorkspaceIdsVisible: vi.fn(async () => undefined),
  filterVisibleByProject: vi.fn(async (_db: unknown, _req: unknown, rows: unknown[]) => rows),
  activityVisibilityCondition: () => undefined,
  runVisibilityCondition: () => undefined,
  issueVisibilityParam: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  runVisibilityParam: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  // Agent visibility (2026-09-30): the rule is owned by the real-Postgres suites
  // (agent-visibility*.test.ts); here it is a pass-through, as A5's guards are.
  resolveAgentVisibility: vi.fn(async () => ({ mode: "all" })),
  visibleAgentIdsFor: vi.fn(async () => null),
  assertAgentIdVisible: vi.fn(async () => undefined),
  agentVisibilityParam: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  agentVisibilityCondition: () => undefined,
  issueVisibilityCondition: () => undefined,
}));

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
      since: undefined,
      includeSystem: undefined,
      visibleWhere: expect.objectContaining({ queryChunks: expect.any(Array) }),
      limit: 100,
    });
    // A plain member's service query must retain the financial exclusion,
    // alongside the pagination defaults asserted above.
    const query = new PgDialect().sqlToQuery(mockActivityService.list.mock.calls[0]![0].visibleWhere);
    expect(query.sql).toContain("not (");
    expect(query.params).toEqual([
      "cost_event", "finance_event", "budget_policy", "budget_incident",
      "cost.%", "finance.%", "budget.%", "company.budget_updated", "agent.budget_updated",
    ]);
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
      since: undefined,
      includeSystem: undefined,
      visibleWhere: expect.objectContaining({ queryChunks: expect.any(Array) }),
      limit: 500,
    });
  });

  it("passes a parsed since through to the activity list (#676)", async () => {
    mockActivityService.list.mockResolvedValue([]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/companies/company-1/activity?since=2026-09-22T00:00:00Z"),
    );

    expect(res.status).toBe(200);
    expect(mockActivityService.list).toHaveBeenCalledWith({
      companyId: "company-1",
      agentId: undefined,
      entityType: undefined,
      entityId: undefined,
      since: new Date("2026-09-22T00:00:00Z"),
      includeSystem: undefined,
      visibleWhere: expect.objectContaining({ queryChunks: expect.any(Array) }),
      limit: 100,
    });
  });

  it("400s on a since the server cannot parse (#676)", async () => {
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/companies/company-1/activity?since=not-a-date"),
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/since/);
    expect(mockActivityService.list).not.toHaveBeenCalled();
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

  // AgentDash (c3 review): run `error` is adapter detail and can carry a
  // credential — it goes through the same serve-time redaction as run logs.
  it("redacts secrets out of run errors served to the issue run list", async () => {
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-uuid-1",
      companyId: "company-1",
    });
    mockActivityService.runsForIssue.mockResolvedValue([
      {
        runId: "run-1",
        status: "cancelled",
        error: "Adapter probe failed with key sk-abcdefghijklmnop1234 attached",
        errorCode: "cancelled_by_operator",
      },
    ]);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl).get("/api/issues/PAP-475/runs"));

    expect(res.status).toBe(200);
    expect(res.body[0].error).not.toContain("sk-abcdefghijklmnop1234");
    expect(res.body[0].error).toContain("Adapter probe failed");
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

  // AgentDash (consolidation PR-C): the manual POST can no longer forge who
  // acted. The server stamps the actor from the principal and marks the row
  // manual, whatever the body claims.
  it("ignores a forged actorType/actorId and stamps the row manual", async () => {
    mockActivityService.create.mockImplementation(async (row: Record<string, unknown>) => ({ id: "act-1", ...row }));
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/activity")
      .send({
        actorType: "system",
        actorId: "system",
        action: "issue.updated",
        entityType: "issue",
        entityId: "issue-1",
        details: { status: { from: "in_progress", to: "done" }, origin: "server" },
      }));

    expect(res.status).toBe(201);
    expect(mockActivityService.create).toHaveBeenCalledTimes(1);
    const row = mockActivityService.create.mock.calls[0]![0];
    expect(row).toMatchObject({
      companyId: "company-1",
      actorType: "user",
      actorId: "user-1",
      action: "issue.updated",
      entityType: "issue",
      entityId: "issue-1",
      origin: "manual",
    });
    expect(row.details).toEqual({ status: { from: "in_progress", to: "done" }, origin: "manual" });
    expect(res.body.origin).toBe("manual");
    expect(res.body.actorType).toBe("user");
  });

  it("does not let a board caller pose as an agent or plugin", async () => {
    mockActivityService.create.mockImplementation(async (row: Record<string, unknown>) => ({ id: "act-2", ...row }));
    const app = await createApp();
    for (const actorType of ["agent", "plugin"] as const) {
      const res = await requestApp(app, (baseUrl) => request(baseUrl)
        .post("/api/companies/company-1/activity")
        .send({ actorType, actorId: "agent-9", action: "approval.approved", entityType: "approval", entityId: "ap-1" }));
      expect(res.status).toBe(201);
    }
    for (const [row] of mockActivityService.create.mock.calls) {
      expect(row).toMatchObject({ actorType: "user", actorId: "user-1", origin: "manual" });
    }
  });

  it("still accepts a legitimate manual post without actor fields", async () => {
    mockActivityService.create.mockImplementation(async (row: Record<string, unknown>) => ({ id: "act-3", ...row }));
    const app = await createApp();
    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/activity")
      .send({ action: "note.added", entityType: "company", entityId: "company-1" }));

    expect(res.status).toBe(201);
    expect(mockActivityService.create.mock.calls[0]![0]).toMatchObject({
      actorType: "user",
      actorId: "user-1",
      action: "note.added",
      agentId: null,
      details: { origin: "manual" },
      origin: "manual",
    });
  });

  it("keeps assistant-grant provenance on a manual post", async () => {
    mockActivityService.create.mockImplementation(async (row: Record<string, unknown>) => ({ id: "act-4", ...row }));
    const app = await createApp({
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "assistant_grant",
      assistantGrantId: "grant-9",
      assistantClientName: "ChatGPT",
      isInstanceAdmin: false,
    });
    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/activity")
      .send({ action: "note.added", entityType: "company", entityId: "company-1" }));

    expect(res.status).toBe(201);
    expect(mockActivityService.create.mock.calls[0]![0]).toMatchObject({
      actorType: "user",
      origin: "manual",
      details: { via: "assistant_grant grant-9 (ChatGPT)", origin: "manual" },
    });
  });

  it("refuses the manual post from an agent credential", async () => {
    const app = await createApp({ type: "agent", agentId: "agent-1", companyId: "company-1", source: "agent_key" });
    const res = await requestApp(app, (baseUrl) => request(baseUrl)
      .post("/api/companies/company-1/activity")
      .send({ actorType: "system", actorId: "system", action: "issue.updated", entityType: "issue", entityId: "issue-1" }));

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
