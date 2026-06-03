// AgentDash (AGE-123): Tests for the agent-run ledger + receipt endpoints.

import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ---------------------------------------------------------------------------
// Mocks — costRoutes imports agentRunService from ../services/index.js and
// quotaService from ../services/quota.js. We mock at those paths.
// vi.mock factories are hoisted, so we use vi.fn() directly and retrieve
// references post-import via the mocked modules.
// ---------------------------------------------------------------------------

vi.mock("../services/index.js", () => ({
  agentRunService: vi.fn().mockReturnValue({
    recordRun: vi.fn(),
    monthlyCount: vi.fn(),
    monthlyCountByAgent: vi.fn(),
    ledger: vi.fn(),
  }),
  budgetService: vi.fn().mockReturnValue({
    overview: vi.fn().mockResolvedValue({ policies: [], activeIncidents: [] }),
    upsertPolicy: vi.fn(),
    resolveIncident: vi.fn(),
  }),
  costService: vi.fn().mockReturnValue({
    createEvent: vi.fn(),
    summary: vi.fn(),
    byAgent: vi.fn(),
    byProject: vi.fn(),
    byAgentModel: vi.fn(),
    byProvider: vi.fn(),
    byBiller: vi.fn(),
    windowSpend: vi.fn(),
    issueTreeSummary: vi.fn(),
  }),
  financeService: vi.fn().mockReturnValue({
    createEvent: vi.fn(),
    summary: vi.fn(),
    byBiller: vi.fn(),
    byKind: vi.fn(),
    list: vi.fn(),
  }),
  companyService: vi.fn().mockReturnValue({
    getById: vi.fn(),
    update: vi.fn(),
  }),
  agentService: vi.fn().mockReturnValue({
    getById: vi.fn(),
    update: vi.fn(),
  }),
  issueService: vi.fn().mockReturnValue({
    getById: vi.fn(),
    getByIdentifier: vi.fn(),
  }),
  heartbeatService: vi.fn().mockReturnValue({
    cancelBudgetScopeWork: vi.fn(),
  }),
  logActivity: vi.fn(),
  classifyComplexity: vi.fn(),
}));

vi.mock("../services/quota.js", () => ({
  quotaService: vi.fn().mockReturnValue({
    getQuota: vi.fn(),
  }),
}));

vi.mock("../services/quota-windows.js", () => ({
  fetchAllQuotaWindows: vi.fn().mockResolvedValue([]),
}));

import { agentRunService } from "../services/index.js";
import { quotaService } from "../services/quota.js";
import { costRoutes } from "../routes/costs.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const MOCK_LEDGER_ROWS = [
  {
    id: "run-1",
    agentId: "agent-1",
    agentName: "Sales Bot",
    issueId: "issue-1",
    issueTitle: "Draft follow-up email",
    complexityTier: "simple",
    costCents: 2,
    tokenCount: 5000,
    durationMs: 30_000,
    completedAt: "2026-06-01T12:00:00.000Z",
  },
  {
    id: "run-2",
    agentId: "agent-2",
    agentName: "Research Bot",
    issueId: null,
    issueTitle: null,
    complexityTier: "complex",
    costCents: 150,
    tokenCount: 120_000,
    durationMs: 900_000,
    completedAt: "2026-06-01T10:00:00.000Z",
  },
];

const MOCK_QUOTA = {
  tier: "free",
  includedRuns: 50,
  usedRuns: 12,
  remainingRuns: 38,
  overageRuns: 0,
  seatsCount: 0,
  billingPeriodStart: "2026-06-01T00:00:00.000Z",
  billingPeriodEnd: "2026-07-01T00:00:00.000Z",
};

const MOCK_MONTHLY = {
  companyId: "co-1",
  month: "2026-06-01T00:00:00.000Z",
  total: 12,
  simple: 8,
  medium: 3,
  complex: 1,
};

/**
 * Get the mock function instances from the mocked service factories.
 * agentRunService is a vi.fn() that returns an object with mock methods.
 * costRoutes calls agentRunService(db) internally, so we access the return
 * value of the mock to set up per-test behavior.
 */
function getRunServiceMocks() {
  const svc = vi.mocked(agentRunService)({} as any);
  return {
    ledger: svc.ledger as ReturnType<typeof vi.fn>,
    monthlyCount: svc.monthlyCount as ReturnType<typeof vi.fn>,
    monthlyCountByAgent: svc.monthlyCountByAgent as ReturnType<typeof vi.fn>,
  };
}

function getQuotaMocks() {
  const svc = vi.mocked(quotaService)({} as any);
  return {
    getQuota: svc.getQuota as ReturnType<typeof vi.fn>,
  };
}

function createApp() {
  const app = express();
  app.use(express.json());

  // Inject actor middleware
  app.use((req: any, _res: any, next: any) => {
    req.actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["co-1"],
      source: "session",
    };
    next();
  });

  app.use("/api", costRoutes({} as any));

  // Error handler
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });

  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/companies/:companyId/agent-runs/ledger", () => {
  it("returns paginated ledger rows", async () => {
    const { ledger } = getRunServiceMocks();
    ledger.mockResolvedValue({
      rows: MOCK_LEDGER_ROWS,
      total: 2,
      hasMore: false,
    });
    const app = createApp();

    const res = await request(app).get("/api/companies/co-1/agent-runs/ledger");

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.rows[0].agentName).toBe("Sales Bot");
    expect(res.body.rows[0].issueTitle).toBe("Draft follow-up email");
    expect(res.body.total).toBe(2);
    expect(res.body.hasMore).toBe(false);
  });

  it("passes query params to the service", async () => {
    const { ledger } = getRunServiceMocks();
    ledger.mockResolvedValue({ rows: [], total: 0, hasMore: false });
    const app = createApp();

    await request(app)
      .get("/api/companies/co-1/agent-runs/ledger?limit=10&offset=20&sort=asc&from=2026-06-01&to=2026-06-30");

    expect(ledger).toHaveBeenCalledWith("co-1", expect.objectContaining({
      limit: 10,
      offset: 20,
      sort: "asc",
    }));
  });

  it("rejects access for non-member", async () => {
    const app = createApp();

    const res = await request(app).get("/api/companies/co-OTHER/agent-runs/ledger");
    expect(res.status).toBe(403);
  });
});

describe("GET /api/companies/:companyId/agent-runs/ledger.csv", () => {
  it("returns CSV content", async () => {
    const { ledger } = getRunServiceMocks();
    ledger.mockResolvedValue({
      rows: MOCK_LEDGER_ROWS,
      total: 2,
      hasMore: false,
    });
    const app = createApp();

    const res = await request(app).get("/api/companies/co-1/agent-runs/ledger.csv");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.text).toContain("Date,Agent,Task,Complexity,Cost ($),Tokens,Duration (min)");
    expect(res.text).toContain("Sales Bot");
    expect(res.text).toContain("Research Bot");
  });
});

describe("GET /api/companies/:companyId/agent-runs/receipt", () => {
  it("returns combined quota + monthly summary", async () => {
    const { monthlyCount, monthlyCountByAgent } = getRunServiceMocks();
    const { getQuota } = getQuotaMocks();
    getQuota.mockResolvedValue(MOCK_QUOTA);
    monthlyCount.mockResolvedValue(MOCK_MONTHLY);
    monthlyCountByAgent.mockResolvedValue([
      { agentId: "agent-1", total: 8, simple: 6, medium: 2, complex: 0 },
      { agentId: "agent-2", total: 4, simple: 2, medium: 1, complex: 1 },
    ]);
    const app = createApp();

    const res = await request(app).get("/api/companies/co-1/agent-runs/receipt");

    expect(res.status).toBe(200);
    expect(res.body.quota.tier).toBe("free");
    expect(res.body.quota.includedRuns).toBe(50);
    expect(res.body.summary.total).toBe(12);
    expect(res.body.activeAgentCount).toBe(2);
    expect(res.body.byAgent).toHaveLength(2);
  });
});
