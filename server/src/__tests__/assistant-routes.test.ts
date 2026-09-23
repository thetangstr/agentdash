import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDigestService = vi.hoisted(() => ({
  digest: vi.fn(),
  audienceAgents: vi.fn(),
}));

const mockAuthorityService = vi.hoisted(() => ({
  requireDecisionActor: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listIssuesForApproval: vi.fn(),
}));

vi.mock("../services/assistant-digest.js", () => ({
  assistantDigestService: () => mockDigestService,
}));

vi.mock("../services/approval-authority.js", () => ({
  approvalAuthorityService: () => mockAuthorityService,
}));

vi.mock("../services/approval-risk.js", () => ({
  APPROVAL_RISK_ORDER: { low: 0, medium: 1, high: 2 },
  summarizeApprovalRisk: vi.fn().mockReturnValue({ level: "low" }),
}));

vi.mock("../services/index.js", () => ({
  approvalService: () => mockApprovalService,
  issueApprovalService: () => mockIssueApprovalService,
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
  const [{ errorHandler }, { assistantRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/assistant.js") as Promise<typeof import("../routes/assistant.js")>,
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { ...actor };
    next();
  });
  app.use(assistantRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("GET /companies/:companyId/assistant/digest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDigestService.digest.mockResolvedValue({
      agentsAnsweredFor: 2,
      since: "2026-09-22T00:00:00.000Z",
      asOf: "2026-09-23T00:00:00.000Z",
      shipped: { total: 1, shown: 1, items: [] },
      blocked: { total: 0, shown: 0, items: [] },
      decisionsWaiting: { total: 0, shown: 0, items: [] },
      truncated: false,
    });
    mockDigestService.audienceAgents.mockResolvedValue([]);
  });

  it("passes a parsed since through to the digest", async () => {
    const app = await createApp();
    const res = await request(app).get(
      "/companies/company-1/assistant/digest?since=2026-09-22T00:00:00Z",
    );
    expect(res.status).toBe(200);
    expect(mockDigestService.digest).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        userId: "user-1",
        since: new Date("2026-09-22T00:00:00Z"),
      }),
    );
  });

  it("defaults to a 24h window when since is omitted", async () => {
    const app = await createApp();
    const res = await request(app).get("/companies/company-1/assistant/digest");
    expect(res.status).toBe(200);
    const arg = mockDigestService.digest.mock.calls[0][0];
    expect(Date.now() - arg.since.getTime()).toBeGreaterThanOrEqual(24 * 3600 * 1000 - 5000);
    expect(Date.now() - arg.since.getTime()).toBeLessThanOrEqual(24 * 3600 * 1000 + 5000);
  });

  it("400s on a since the server cannot parse", async () => {
    const app = await createApp();
    const res = await request(app).get(
      "/companies/company-1/assistant/digest?since=not-a-date",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/since/);
    expect(mockDigestService.digest).not.toHaveBeenCalled();
  });

  it("passes projectId through when given", async () => {
    const app = await createApp();
    const res = await request(app).get(
      "/companies/company-1/assistant/digest?projectId=project-9",
    );
    expect(res.status).toBe(200);
    expect(mockDigestService.digest).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-9" }),
    );
  });

  it("refuses an agent-key actor", async () => {
    const app = await createApp({ type: "agent", agentId: "agent-1", companyId: "company-1" });
    const res = await request(app).get("/companies/company-1/assistant/digest");
    expect(res.status).toBe(403);
  });
});

describe("GET /companies/:companyId/assistant/pending-decisions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDigestService.audienceAgents.mockResolvedValue([
      { id: "agent-1", name: "Priya", role: "engineer" },
    ]);
    mockAuthorityService.requireDecisionActor.mockResolvedValue("steward");
    mockIssueApprovalService.listIssuesForApproval.mockResolvedValue([
      { id: "issue-1", identifier: "ACME-311", title: "Checkout retries" },
    ]);
    mockApprovalService.list.mockResolvedValue([
      {
        id: "appr-1",
        companyId: "company-1",
        type: "connector_send",
        status: "pending",
        revision: 1,
        payload: { secret: "not-echoed" },
        requestedByAgentId: "agent-1",
        createdAt: new Date("2026-09-23T01:00:00Z"),
      },
      {
        id: "appr-2",
        companyId: "company-1",
        type: "hire_agent",
        status: "approved",
        revision: 1,
        payload: {},
        requestedByAgentId: "agent-1",
        createdAt: new Date("2026-09-22T01:00:00Z"),
      },
      {
        id: "appr-3",
        companyId: "company-1",
        type: "send_email",
        status: "pending",
        revision: 1,
        payload: {},
        requestedByAgentId: "agent-9",
        createdAt: new Date("2026-09-23T02:00:00Z"),
      },
    ]);
  });

  it("lists only open approvals from agents the person answers for, with canDecide", async () => {
    const app = await createApp();
    const res = await request(app).get("/companies/company-1/assistant/pending-decisions");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.decisions).toHaveLength(1);
    const decision = res.body.decisions[0];
    expect(decision.approvalId).toBe("appr-1");
    expect(decision.kind).toBe("connector_send");
    expect(decision.askedBy).toBe("Priya");
    expect(decision.canDecide).toBe(true);
    expect(decision.relatedItem.identifier).toBe("ACME-311");
    expect(decision.summary).toMatch(/Priya asks to/);
    // Payload content is reduced to kind + summary — never echoed.
    expect(JSON.stringify(res.body)).not.toContain("not-echoed");
  });

  it("reports canDecide false when the authority refuses or returns no role", async () => {
    mockAuthorityService.requireDecisionActor.mockRejectedValue(new Error("nope"));
    const app = await createApp();
    const res = await request(app).get("/companies/company-1/assistant/pending-decisions");
    expect(res.status).toBe(200);
    expect(res.body.decisions[0].canDecide).toBe(false);
  });
});
