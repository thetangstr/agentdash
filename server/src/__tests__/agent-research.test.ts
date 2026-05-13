import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mock fetch (used by agent-research service) ────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── Mock DB ─────────────────────────────────────────────────────────────────
const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  insert: vi.fn().mockReturnThis(),
  values: vi.fn().mockReturnThis(),
  onConflictDoUpdate: vi.fn().mockReturnThis(),
  limit: vi.fn(),
};

const mockCompanies = [
  { id: "company-1", name: "Acme Corp", description: "A test company" },
];

const mockContextRows = [
  { key: "domain", value: "Technology" },
  { key: "tech_stack", value: "React, Node.js" },
];

beforeEach(() => {
  vi.resetAllMocks();
  mockFetch.mockReset();
});

// ── Import after mocks are set up ────────────────────────────────────────────
async function createApp(actorOverrides: Record<string, unknown> = {}) {
  vi.resetModules();
  const { errorHandler } = await import("../middleware/index.js");
  const { agentResearchRoutes } = await import("../routes/agent-research.js");

  const actor = {
    type: "board",
    userId: "user-1",
    companyIds: ["company-1"],
    source: "local_implicit",
    isInstanceAdmin: false,
    memberships: [{ companyId: "company-1", status: "active", membershipRole: "owner" }],
    ...actorOverrides,
  };

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.actor = { ...actor };
    next();
  });
  app.use("/api", agentResearchRoutes(mockDb as any));
  app.use(errorHandler);
  return app;
}

describe("POST /api/companies/:companyId/agent-research", () => {
  beforeEach(() => {
    // Mock companies select
    (mockDb.select as any).mockReturnThis();
    (mockDb.from as any).mockReturnThis();
    (mockDb.where as any).mockReturnThis();
    (mockDb.limit as any).mockResolvedValue(mockCompanies);

    // Mock companyContext select (for context rows)
    const contextSelect = vi.fn().mockReturnThis();
    const contextWhere = vi.fn().mockReturnThis();
    const contextFrom = vi.fn().mockResolvedValue(mockContextRows);
    mockDb.select.mockImplementation(() => ({
      from: (table: any) => {
        if (table.__kind === "company") return { where: contextWhere, limit: vi.fn().mockResolvedValue(mockCompanies) };
        return { where: contextWhere, limit: vi.fn().mockResolvedValue(mockContextRows) };
      },
    }));
  });

  it("returns 200 with valid upstream response", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "assess-123",
        companyName: "Acme Corp",
        industry: "Technology",
        status: "done",
        outputMarkdown: "# Readiness Report\n\nAcme Corp is ready.",
        durationMs: 1500,
        createdAt: "2026-01-01T00:00:00Z",
      }),
    });

    mockDb.insert.mockReturnValue({ values: vi.fn().mockReturnThis(), onConflictDoUpdate: vi.fn().mockReturnThis() });

    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/agent-research")
      .send({ companyUrl: "https://acme.com" });

    expect(res.status).toBe(200);
    expect(res.body.outputMarkdown).toBe("# Readiness Report\n\nAcme Corp is ready.");
    expect(res.body.id).toBe("assess-123");
  });

  it("returns 502 when upstream returns a non-2xx status", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/agent-research")
      .send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("500");
  });

  it("returns 502 when upstream response fails Zod validation", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        // missing required fields — should fail AssessmentResultSchema
        foo: "bar",
      }),
    });

    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/agent-research")
      .send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toContain("malformed");
  });

  it("returns 503 when RESEARCH_APP_URL is not configured", async () => {
    const currentUrl = process.env.RESEARCH_APP_URL;
    const currentKey = process.env.RESEARCH_APP_API_KEY;
    try {
      delete process.env.RESEARCH_APP_URL;
      delete process.env.RESEARCH_APP_API_KEY;

      const app = await createApp();
      const res = await request(app)
        .post("/api/companies/company-1/agent-research")
        .send({});

      expect(res.status).toBe(503);
      expect(res.body.error).toContain("not configured");
    } finally {
      process.env.RESEARCH_APP_URL = currentUrl ?? "";
      process.env.RESEARCH_APP_API_KEY = currentKey ?? "";
    }
  });
});

describe("GET /api/companies/:companyId/agent-research", () => {
  it("returns 200 with stored assessment", async () => {
    mockDb.select.mockReturnValueOnce({ from: vi.fn().mockReturnValueOnce({ where: vi.fn().mockReturnValueOnce({ limit: vi.fn().mockResolvedValue([mockCompanies[0]]) }) }) });
    mockDb.select.mockReturnValueOnce({ from: vi.fn().mockReturnValueOnce({ where: vi.fn().mockReturnValueOnce({ limit: vi.fn().mockResolvedValue([
      { companyId: "company-1", contextType: "agent_research", key: "readiness-assessment", value: "# Report\n\nReady." },
      { companyId: "company-1", contextType: "agent_research", key: "assessment-id", value: "assess-456" },
    ]) }) }) });

    const app = await createApp();
    const res = await request(app).get("/api/companies/company-1/agent-research");

    expect(res.status).toBe(200);
    expect(res.body.markdown).toBe("# Report\n\nReady.");
    expect(res.body.assessmentId).toBe("assess-456");
  });

  it("returns 404 when no assessment exists", async () => {
    mockDb.select.mockReturnValueOnce({ from: vi.fn().mockReturnValueOnce({ where: vi.fn().mockReturnValueOnce({ limit: vi.fn().mockResolvedValue([mockCompanies[0]]) }) }) });
    mockDb.select.mockReturnValueOnce({ from: vi.fn().mockReturnValueOnce({ where: vi.fn().mockReturnValueOnce({ limit: vi.fn().mockResolvedValue([]) }) }) });

    const app = await createApp();
    const res = await request(app).get("/api/companies/company-1/agent-research");

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("No assessment found");
  });
});
