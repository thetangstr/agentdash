import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/index.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, agentRunService: vi.fn().mockReturnValue({ recordRun: vi.fn(), monthlyCount: vi.fn(), monthlyCountByAgent: vi.fn() }) };
});
import { afterAll, afterEach, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { HEARTBEAT_RUN_STATUSES } from "@paperclipai/shared";
import { createDb, companies, agents, costEvents, financeEvents, heartbeatRuns, issues, projects } from "@paperclipai/db";
import { costService } from "../services/costs.ts";
import { financeService } from "../services/finance.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

function makeDb(overrides: Record<string, unknown> = {}) {
  const selectChain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: vi.fn().mockResolvedValue([]),
  };

  const thenableChain = Object.assign(Promise.resolve([]), selectChain);

  return {
    select: vi.fn().mockReturnValue(thenableChain),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    }),
    ...overrides,
  };
}

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));
const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
}));
const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));
const mockHeartbeatService = vi.hoisted(() => ({
  cancelBudgetScopeWork: vi.fn().mockResolvedValue(undefined),
}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockFetchAllQuotaWindows = vi.hoisted(() => vi.fn());
const mockCostService = vi.hoisted(() => ({
  createEvent: vi.fn(),
  summary: vi.fn().mockResolvedValue({ spendCents: 0 }),
  byAgent: vi.fn().mockResolvedValue([]),
  byAgentModel: vi.fn().mockResolvedValue([]),
  byProvider: vi.fn().mockResolvedValue([]),
  byBiller: vi.fn().mockResolvedValue([]),
  issueTreeSummary: vi.fn().mockResolvedValue({
    issueId: "issue-1",
    issueCount: 1,
    includeDescendants: true,
    costCents: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  }),
  windowSpend: vi.fn().mockResolvedValue([]),
  byProject: vi.fn().mockResolvedValue([]),
  runActivity: vi.fn().mockResolvedValue({
    companyId: "company-1",
    totalRuns: 3,
    succeededRuns: 2,
    failedRuns: 1,
    totalSeconds: 90,
    medianSeconds: 30,
    p90Seconds: 46,
    lastRunAt: null,
  }),
}));
const mockFinanceService = vi.hoisted(() => ({
  createEvent: vi.fn(),
  summary: vi.fn().mockResolvedValue({ debitCents: 0, creditCents: 0, netCents: 0, estimatedDebitCents: 0, eventCount: 0 }),
  byBiller: vi.fn().mockResolvedValue([]),
  byKind: vi.fn().mockResolvedValue([]),
  list: vi.fn().mockResolvedValue([]),
}));
const mockBudgetService = vi.hoisted(() => ({
  overview: vi.fn().mockResolvedValue({
    companyId: "company-1",
    policies: [],
    activeIncidents: [],
    pausedAgentCount: 0,
    pausedProjectCount: 0,
    pendingApprovalCount: 0,
  }),
  upsertPolicy: vi.fn(),
  resolveIncident: vi.fn(),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    agentInstructionRefreshService: () => ({ refreshForAgent: vi.fn(), refreshForRole: vi.fn() }),
    ISSUE_LIST_DEFAULT_LIMIT: 50,
    // AGE-119: costRoutes constructs agentRunService(db) at setup; the per-test
    // mock must provide it or costRoutes throws "No agentRunService export".
    agentRunService: () => ({ recordRun: vi.fn(), monthlyCount: vi.fn(), monthlyCountByAgent: vi.fn() }),
    budgetService: () => mockBudgetService,
    costService: () => mockCostService,
    financeService: () => mockFinanceService,
    companyService: () => mockCompanyService,
    agentService: () => mockAgentService,
    issueService: () => mockIssueService,
    heartbeatService: () => mockHeartbeatService,
    logActivity: mockLogActivity,
  }));

  vi.doMock("../services/quota-windows.js", () => ({
    fetchAllQuotaWindows: mockFetchAllQuotaWindows,
  }));
}

async function createApp() {
  const [{ costRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/costs.js")>("../routes/costs.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", userId: "board-user", source: "local_implicit" };
    next();
  });
  app.use("/api", costRoutes(makeDb() as any));
  app.use(errorHandler);
  return app;
}

async function createAppWithActor(actor: any) {
  const [{ costRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/costs.js")>("../routes/costs.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", costRoutes(makeDb() as any));
  app.use(errorHandler);
  return app;
}

async function loadCostParsers() {
  const { parseCostDateRange, parseCostLimit } = await import("../routes/costs.js");
  return { parseCostDateRange, parseCostLimit };
}

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock("../services/index.js");
  vi.doUnmock("../services/quota-windows.js");
  vi.doUnmock("../routes/costs.js");
  vi.doUnmock("../middleware/index.js");
  registerModuleMocks();
  vi.clearAllMocks();
  mockCompanyService.update.mockResolvedValue({
    id: "company-1",
    name: "Paperclip",
    budgetMonthlyCents: 100,
    spentMonthlyCents: 0,
  });
  mockAgentService.getById.mockResolvedValue({
    id: "agent-1",
    companyId: "company-1",
    name: "Budget Agent",
    budgetMonthlyCents: 100,
    spentMonthlyCents: 0,
  });
  mockAgentService.update.mockResolvedValue({
    id: "agent-1",
    companyId: "company-1",
    name: "Budget Agent",
    budgetMonthlyCents: 100,
    spentMonthlyCents: 0,
  });
  mockIssueService.getById.mockResolvedValue({
    id: "issue-1",
    companyId: "company-1",
    identifier: "PAP-1",
  });
  mockIssueService.getByIdentifier.mockResolvedValue({
    id: "issue-1",
    companyId: "company-1",
    identifier: "PAP-1",
  });
  mockBudgetService.upsertPolicy.mockResolvedValue(undefined);
});

describe("cost routes", () => {
  it("accepts valid ISO date strings", async () => {
    const { parseCostDateRange } = await loadCostParsers();
    expect(parseCostDateRange({
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-31T23:59:59.999Z",
    })).toEqual({
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-01-31T23:59:59.999Z"),
    });
  });

  it("returns 400 for an invalid 'from' date string", async () => {
    const { parseCostDateRange } = await loadCostParsers();
    expect(() => parseCostDateRange({ from: "not-a-date" })).toThrow(/invalid 'from' date/i);
  });

  it("returns 400 for an invalid 'to' date string", async () => {
    const { parseCostDateRange } = await loadCostParsers();
    expect(() => parseCostDateRange({ to: "banana" })).toThrow(/invalid 'to' date/i);
  });

  it("returns finance summary rows for valid requests", async () => {
    const app = await createApp();
    const res = await request(app)
      .get("/api/companies/company-1/costs/finance-summary")
      .query({ from: "2026-02-01T00:00:00.000Z", to: "2026-02-28T23:59:59.999Z" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      debitCents: 0,
      creditCents: 0,
      netCents: 0,
      estimatedDebitCents: 0,
      eventCount: 0,
    });
  });

  it("returns issue subtree cost summaries for issue refs", async () => {
    const app = await createApp();
    const res = await request(app).get("/api/issues/PAP-1/cost-summary");

    expect(res.status).toBe(200);
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("PAP-1");
    expect(mockCostService.issueTreeSummary).toHaveBeenCalledWith("company-1", "issue-1");
    expect(res.body).toEqual({
      issueId: "issue-1",
      issueCount: 1,
      includeDescendants: true,
      costCents: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
  });

  it("returns 400 for invalid finance event list limits", async () => {
    const { parseCostLimit } = await loadCostParsers();
    expect(() => parseCostLimit({ limit: "0" })).toThrow(/invalid 'limit'/i);
  });

  it("accepts valid finance event list limits", async () => {
    const { parseCostLimit } = await loadCostParsers();
    expect(parseCostLimit({ limit: "25" })).toBe(25);
  });

  /**
   * Run activity sits beside the spend figures and is reached from the same
   * page, so it inherits the same visibility rule. Adding a route that reports
   * how much work an agent did, readable by anyone who cannot see spend, would
   * be a quiet widening of who sees operational detail.
   */
  it("serves run activity to an authorised reader", async () => {
    const app = await createApp();
    const res = await request(app).get("/api/companies/company-1/costs/run-activity");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ totalRuns: 3, succeededRuns: 2, failedRuns: 1, medianSeconds: 30 });
  });

  it("is behind the spend-visibility guard, not merely company access", async () => {
    /**
     * Structural, and deliberately so.
     *
     * The behavioural version of this test did not work: with the stubbed db
     * in this file `access.canUser` resolves truthy, so a member reaches BOTH
     * this route and the pre-existing `/costs/summary`. Swapping the guard for
     * the weaker `assertCompanyAccess` changed nothing observable, and the
     * outside-the-company actor that did return 403 is refused by either guard
     * — so the test passed for a reason unrelated to what it claimed.
     *
     * This asserts the thing that actually differs. It proves the guard is
     * wired, not that the guard is correct; `assertSpendVisibility` itself is
     * shared with every other route here and covered by their tests.
     */
    const source = await readFile(
      new URL("../routes/costs.ts", import.meta.url),
      "utf8",
    );
    const handler = source.slice(
      source.indexOf('router.get("/companies/:companyId/costs/run-activity"'),
    );
    const body = handler.slice(0, handler.indexOf("});"));
    expect(body).toContain("assertSpendVisibility(req, companyId)");
    expect(body, "assertCompanyAccess alone would let a member read run counts")
      .not.toMatch(/^\s*assertCompanyAccess\(req, companyId\);\s*$/m);
  });

  it("rejects company budget updates for board users outside the company", async () => {
    const app = await createAppWithActor({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-2"],
    });

    const res = await request(app)
      .patch("/api/companies/company-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(403);
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });

  it("rejects agent budget updates for board users outside the agent company", async () => {
    const app = await createAppWithActor({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-2"],
    });

    const res = await request(app)
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(403);
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });

  it("rejects agent budget updates from the target agent without changing the budget policy", async () => {
    const app = await createAppWithActor({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Board access required" });
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(mockBudgetService.upsertPolicy).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects agent budget updates from another same-company agent without changing the budget policy", async () => {
    const app = await createAppWithActor({
      type: "agent",
      agentId: "agent-2",
      companyId: "company-1",
      runId: "run-2",
    });

    const res = await request(app)
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Board access required" });
    expect(mockAgentService.update).not.toHaveBeenCalled();
    expect(mockBudgetService.upsertPolicy).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("allows authorized board users to update an agent budget and budget policy", async () => {
    mockAgentService.update.mockResolvedValueOnce({
      id: "agent-1",
      companyId: "company-1",
      name: "Budget Agent",
      budgetMonthlyCents: 2500,
      spentMonthlyCents: 0,
    });
    const app = await createAppWithActor({
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "admin" }],
    });

    const res = await request(app)
      .patch("/api/agents/agent-1/budgets")
      .send({ budgetMonthlyCents: 2500 });

    expect(res.status).toBe(200);
    expect(mockAgentService.update).toHaveBeenCalledWith("agent-1", { budgetMonthlyCents: 2500 });
    expect(mockBudgetService.upsertPolicy).toHaveBeenCalledWith(
      "company-1",
      {
        scopeType: "agent",
        scopeId: "agent-1",
        amount: 2500,
        windowKind: "calendar_month_utc",
      },
      "board-user",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        actorType: "user",
        actorId: "board-user",
        agentId: null,
        action: "agent.budget_updated",
        entityType: "agent",
        entityId: "agent-1",
        details: { budgetMonthlyCents: 2500 },
      }),
    );
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("cost and finance aggregate overflow handling", () => {
  let db!: ReturnType<typeof createDb>;
  let costs!: ReturnType<typeof costService>;
  let finance!: ReturnType<typeof financeService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-costs-service-");
    db = createDb(tempDb.connectionString);
    costs = costService(db);
    finance = financeService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(financeEvents);
    await db.delete(costEvents);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("aggregates cost event sums above int32 without raising Postgres integer overflow", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cost Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Overflow Project",
      status: "active",
    });

    await db.insert(costEvents).values([
      {
        companyId,
        agentId,
        projectId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 2_000_000_000,
        cachedInputTokens: 0,
        outputTokens: 200_000_000,
        costCents: 2_000_000_000,
        occurredAt: new Date("2026-04-10T00:00:00.000Z"),
      },
      {
        companyId,
        agentId,
        projectId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 2_000_000_000,
        cachedInputTokens: 10,
        outputTokens: 200_000_000,
        costCents: 2_000_000_000,
        occurredAt: new Date("2026-04-11T00:00:00.000Z"),
      },
    ]);

    const range = {
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-15T23:59:59.999Z"),
    };

    const [byAgentRow] = await costs.byAgent(companyId, range);
    const [byProjectRow] = await costs.byProject(companyId, range);
    const [byAgentModelRow] = await costs.byAgentModel(companyId, range);

    expect(byAgentRow?.costCents).toBe(4_000_000_000);
    expect(byAgentRow?.inputTokens).toBe(4_000_000_000);
    expect(byProjectRow?.costCents).toBe(4_000_000_000);
    expect(byAgentModelRow?.costCents).toBe(4_000_000_000);
  });

  it("aggregates issue costs across recursive descendants only", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    const grandchildIssueId = randomUUID();
    const siblingIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cost Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        title: "Root",
        status: "in_progress",
        priority: "medium",
        issueNumber: 1,
        identifier: "TST-1",
      },
      {
        id: childIssueId,
        companyId,
        parentId: rootIssueId,
        title: "Child",
        status: "done",
        priority: "medium",
        issueNumber: 2,
        identifier: "TST-2",
      },
      {
        id: grandchildIssueId,
        companyId,
        parentId: childIssueId,
        title: "Grandchild",
        status: "done",
        priority: "medium",
        issueNumber: 3,
        identifier: "TST-3",
      },
      {
        id: siblingIssueId,
        companyId,
        title: "Sibling",
        status: "done",
        priority: "medium",
        issueNumber: 4,
        identifier: "TST-4",
      },
    ]);
    await db.insert(costEvents).values([
      {
        companyId,
        agentId,
        issueId: rootIssueId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 10,
        cachedInputTokens: 1,
        outputTokens: 2,
        costCents: 100,
        occurredAt: new Date("2026-04-10T00:00:00.000Z"),
      },
      {
        companyId,
        agentId,
        issueId: childIssueId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 20,
        cachedInputTokens: 2,
        outputTokens: 4,
        costCents: 200,
        occurredAt: new Date("2026-04-10T00:01:00.000Z"),
      },
      {
        companyId,
        agentId,
        issueId: grandchildIssueId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 30,
        cachedInputTokens: 3,
        outputTokens: 6,
        costCents: 300,
        occurredAt: new Date("2026-04-10T00:02:00.000Z"),
      },
      {
        companyId,
        agentId,
        issueId: siblingIssueId,
        provider: "openai",
        biller: "openai",
        billingType: "metered_api",
        model: "gpt-5",
        inputTokens: 40,
        cachedInputTokens: 4,
        outputTokens: 8,
        costCents: 400,
        occurredAt: new Date("2026-04-10T00:03:00.000Z"),
      },
    ]);

    const summary = await costs.issueTreeSummary(companyId, rootIssueId);

    expect(summary).toEqual({
      issueId: rootIssueId,
      issueCount: 3,
      includeDescendants: true,
      costCents: 600,
      inputTokens: 60,
      cachedInputTokens: 6,
      outputTokens: 12,
    });
  });

  it("aggregates finance event sums above int32 without raising Postgres integer overflow", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(financeEvents).values([
      {
        companyId,
        biller: "openai",
        eventKind: "invoice",
        amountCents: 2_000_000_000,
        currency: "USD",
        direction: "debit",
        estimated: false,
        occurredAt: new Date("2026-04-10T00:00:00.000Z"),
      },
      {
        companyId,
        biller: "openai",
        eventKind: "invoice",
        amountCents: 2_000_000_000,
        currency: "USD",
        direction: "debit",
        estimated: true,
        occurredAt: new Date("2026-04-11T00:00:00.000Z"),
      },
    ]);

    const range = {
      from: new Date("2026-04-01T00:00:00.000Z"),
      to: new Date("2026-04-15T23:59:59.999Z"),
    };

    const summary = await finance.summary(companyId, range);
    const [byKindRow] = await finance.byKind(companyId, range);

    expect(summary.debitCents).toBe(4_000_000_000);
    expect(summary.estimatedDebitCents).toBe(2_000_000_000);
    expect(byKindRow?.debitCents).toBe(4_000_000_000);
    expect(byKindRow?.netCents).toBe(4_000_000_000);
  });
});

/**
 * "Nothing was spent" and "nothing could be measured" are different claims that
 * both arrive as `spendCents: 0`.
 *
 * On this deployment the second is the true one — the local Hermes adapter
 * emits no token counts, so no cost event is ever written and the dashboard
 * would otherwise render a confident $0.00. Verified on both live instances: 30
 * runs, zero usage records, zero cost events.
 *
 * `measured` exists to separate them. It is deliberately unbounded by the date
 * range: the question is whether metering works at all, not whether this
 * particular window happened to be quiet.
 */
describeEmbeddedPostgres("cost summary distinguishes unmeasured from zero", () => {
  let db!: ReturnType<typeof createDb>;
  let costs!: ReturnType<typeof costService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-costs-measured-");
    db = createDb(tempDb.connectionString);
    costs = costService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(costEvents);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    // A cost event needs an agent to attribute the spend to.
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CoS",
      role: "chief_of_staff",
      status: "idle",
      adapterType: "hermes_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("reports measured=false when nothing has ever been recorded", async () => {
    const { companyId } = await seedCompany();
    const summary = await costs.summary(companyId);
    expect(summary.spendCents).toBe(0);
    expect(summary.measured, "an unmeasured company must not look like a zero-spend one").toBe(false);
  });

  it("reports measured=true once any cost event exists", async () => {
    const { companyId, agentId } = await seedCompany();
    await db.insert(costEvents).values({
      companyId,
      agentId,
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 50,
      provider: "test",
      biller: "test",
      billingType: "tokens",
      model: "test-model",
      costCents: 250,
      occurredAt: new Date("2026-08-14T12:00:00.000Z"),
    });

    const summary = await costs.summary(companyId);
    expect(summary.measured).toBe(true);
    expect(summary.spendCents).toBe(250);
  });

  it("stays measured=true for an empty date range that legitimately has no spend", async () => {
    // The distinction that makes this worth having: a quiet WEEK on a metered
    // company is a real zero and must read as one. Only a company that has
    // never recorded anything is "not measured".
    const { companyId, agentId } = await seedCompany();
    await db.insert(costEvents).values({
      companyId,
      agentId,
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 50,
      provider: "test",
      biller: "test",
      billingType: "tokens",
      model: "test-model",
      costCents: 250,
      occurredAt: new Date("2026-08-14T12:00:00.000Z"),
    });

    const summary = await costs.summary(companyId, {
      from: new Date("2026-01-01T00:00:00.000Z"),
      to: new Date("2026-01-31T00:00:00.000Z"),
    });
    expect(summary.spendCents).toBe(0);
    expect(summary.measured, "a quiet range on a metered company is a real zero").toBe(true);
  });

  /**
   * The other half of the same problem. A page that can only report what it
   * does not know reads as though nothing is happening — untrue on both live
   * instances, where 69 and 8 runs respectively are recorded with complete
   * timings. These are the figures that go beside "Not measured".
   */
  describe("runActivity", () => {
    async function seedRun(
      companyId: string,
      agentId: string,
      status: string,
      startedAt: Date,
      durationSeconds: number,
    ) {
      await db.insert(heartbeatRuns).values({
        companyId,
        agentId,
        status,
        invocationSource: "schedule",
        startedAt,
        finishedAt: new Date(startedAt.getTime() + durationSeconds * 1000),
      });
    }

    it("reports counts and wall-clock, which we do record", async () => {
      const { companyId, agentId } = await seedCompany();
      const base = new Date("2026-08-14T12:00:00.000Z");
      await seedRun(companyId, agentId, "succeeded", base, 10);
      await seedRun(companyId, agentId, "succeeded", new Date(base.getTime() + 60_000), 30);
      await seedRun(companyId, agentId, "failed", new Date(base.getTime() + 120_000), 50);

      const activity = await costs.runActivity(companyId);
      expect(activity.totalRuns).toBe(3);
      expect(activity.succeededRuns).toBe(2);
      expect(activity.failedRuns).toBe(1);
      expect(activity.totalSeconds).toBe(90);
      expect(activity.medianSeconds).toBe(30);
    });

    it("classifies every status the system actually writes", async () => {
      /**
       * The bug this exists to prevent, found by reading the live database
       * back rather than trusting a 200: the first version filtered on
       * 'completed' and reported 0 successes out of 73 real runs, because
       * `heartbeat_runs.status` is 'succeeded' — 'completed' belongs to
       * `RUN_LIVENESS_STATES`, a different column.
       *
       * Seeding from HEARTBEAT_RUN_STATUSES rather than hand-written literals
       * is the point. A test that seeds the same invented string the
       * implementation filters on agrees with itself and proves nothing.
       */
      const { companyId, agentId } = await seedCompany();
      const base = new Date("2026-08-14T12:00:00.000Z");
      for (const [index, status] of HEARTBEAT_RUN_STATUSES.entries()) {
        await seedRun(companyId, agentId, status, new Date(base.getTime() + index * 60_000), 10);
      }

      const activity = await costs.runActivity(companyId);
      expect(activity.totalRuns).toBe(HEARTBEAT_RUN_STATUSES.length);
      expect(activity.succeededRuns, "exactly one seeded run succeeded").toBe(1);
      expect(activity.failedRuns, "'failed' and 'timed_out' both count as failure").toBe(2);
      // Neither number may be zero: that is precisely how the bug presented.
      expect(activity.succeededRuns).toBeGreaterThan(0);
      expect(activity.failedRuns).toBeGreaterThan(0);
    });

    it("returns null durations rather than a zero when there are no runs", async () => {
      // A "0s median" would be the same false-confidence bug the measured flag
      // exists to remove, just moved one column across.
      const { companyId } = await seedCompany();
      const activity = await costs.runActivity(companyId);
      expect(activity.totalRuns).toBe(0);
      expect(activity.medianSeconds).toBeNull();
      expect(activity.p90Seconds).toBeNull();
    });

    it("ignores a run that never finished", async () => {
      // An in-flight run has no wall-clock yet. Counting it with a null finish
      // would either crash the percentile or silently treat it as instant.
      const { companyId, agentId } = await seedCompany();
      await seedRun(companyId, agentId, "succeeded", new Date("2026-08-14T12:00:00.000Z"), 20);
      await db.insert(heartbeatRuns).values({
        companyId,
        agentId,
        status: "running",
        invocationSource: "schedule",
        startedAt: new Date("2026-08-14T13:00:00.000Z"),
        finishedAt: null,
      });

      const activity = await costs.runActivity(companyId);
      expect(activity.totalRuns).toBe(1);
      expect(activity.totalSeconds).toBe(20);
    });

    it("honours the date range", async () => {
      const { companyId, agentId } = await seedCompany();
      await seedRun(companyId, agentId, "succeeded", new Date("2026-08-14T12:00:00.000Z"), 20);
      await seedRun(companyId, agentId, "succeeded", new Date("2026-01-05T12:00:00.000Z"), 20);

      const activity = await costs.runActivity(companyId, {
        from: new Date("2026-08-01T00:00:00.000Z"),
        to: new Date("2026-08-31T00:00:00.000Z"),
      });
      expect(activity.totalRuns).toBe(1);
    });
  });
});

