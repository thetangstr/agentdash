import express from "express";
import { getTableName } from "drizzle-orm";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDigestService = vi.hoisted(() => ({
  digest: vi.fn(),
  audienceAgents: vi.fn(),
  tasksAssignedTo: vi.fn(),
  visibleProjectIds: vi.fn(),
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

const mockSummarizeApprovalRisk = vi.hoisted(() => vi.fn());

vi.mock("../services/assistant-digest.js", () => ({
  assistantDigestService: () => mockDigestService,
}));

vi.mock("../services/approval-authority.js", () => ({
  approvalAuthorityService: () => mockAuthorityService,
}));

vi.mock("../services/approval-risk.js", () => ({
  APPROVAL_RISK_ORDER: { high: 0, medium: 1, low: 2 },
  summarizeApprovalRisk: mockSummarizeApprovalRisk,
}));

// GH #830 follow-up: pending-decisions drops a related issue the caller
// cannot see. That rule runs against a real database in
// project-visibility-relations.test.ts; this suite's stub db cannot answer it.
vi.mock("../routes/visibility.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../routes/visibility.js")>()),
  listVisibleIssueIds: vi.fn(async (_db: unknown, _req: unknown, _companyId: unknown, ids: Iterable<string>) => new Set(ids)),
  // The review list's composed issue rule (owner-only agents) runs against a
  // real database in waiting-on-you-reviews.test.ts; here every agent is visible.
  resolveAgentVisibility: vi.fn(async () => ({ mode: "all" })),
  issueVisibilityCondition: vi.fn(() => undefined),
  agentVisibilityCondition: vi.fn(() => undefined),
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
  // These approval/task fixtures contain no pending questions. Keep the real
  // waiting-on-you composition and its authority/visibility predicates; adapt
  // only its added SELECT-only question and review readers to that explicit
  // empty dataset (the review reader ends at `limit`, the question reader at
  // `offset`).
  const emptyQuestions: Record<string, unknown> = {
    from(table: Parameters<typeof getTableName>[0]) {
      if (!["issue_thread_interactions", "issues"].includes(getTableName(table))) throw new Error("Unexpected fixture query");
      return emptyQuestions;
    },
    innerJoin: () => emptyQuestions,
    leftJoin: () => emptyQuestions,
    where: () => emptyQuestions,
    orderBy: () => emptyQuestions,
    limit: () => Object.assign(Promise.resolve([]), { offset: async () => [] }),
  };
  app.use(assistantRoutes({ select: () => emptyQuestions } as never));
  app.use(errorHandler);
  return app;
}

describe("GET /companies/:companyId/assistant/digest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDigestService.visibleProjectIds.mockResolvedValue(new Set(["project-9"]));
    mockDigestService.digest.mockResolvedValue({
      agentsAnsweredFor: 2,
      since: "2026-09-22T00:00:00.000Z",
      asOf: "2026-09-23T00:00:00.000Z",
      shipped: { total: 1, shown: 1, items: [] },
      blockedNow: { total: 0, shown: 0, items: [] },
      newlyBlocked: { total: 0, shown: 0, items: [] },
      decisionsWaiting: { total: 0, shown: 0, items: [] },
      truncated: false,
    });
    mockDigestService.audienceAgents.mockResolvedValue([]);
    mockDigestService.tasksAssignedTo.mockResolvedValue({
      manual: { total: 0, items: [] },
      other: { total: 0, items: [] },
    });
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

  it("400s on a bare numeral — new Date alone would accept it", async () => {
    const app = await createApp();
    const res = await request(app).get(
      "/companies/company-1/assistant/digest?since=1",
    );
    expect(res.status).toBe(400);
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

  // AgentDash consolidation PR-A (review H3): the route validates projectId.
  it("returns 404 for a projectId the caller cannot see, before any digest work", async () => {
    const app = await createApp();
    const res = await request(app).get(
      "/companies/company-1/assistant/digest?projectId=restricted-or-foreign",
    );
    expect(res.status).toBe(404);
    expect(mockDigestService.digest).not.toHaveBeenCalled();
  });

  it("passes the caller's visible project set into the digest", async () => {
    const app = await createApp();
    await request(app).get("/companies/company-1/assistant/digest");
    expect(mockDigestService.digest).toHaveBeenCalledWith(
      expect.objectContaining({ visibleProjectIds: new Set(["project-9"]) }),
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
    mockDigestService.tasksAssignedTo.mockResolvedValue({
      manual: { total: 0, items: [] },
      other: { total: 0, items: [] },
    });
    mockAuthorityService.requireDecisionActor.mockResolvedValue("steward");
    mockSummarizeApprovalRisk.mockReset().mockReturnValue({ level: "low" });
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

  it("reports canDecide false only when the authority throws", async () => {
    mockAuthorityService.requireDecisionActor.mockRejectedValue(new Error("nope"));
    const app = await createApp();
    const res = await request(app).get("/companies/company-1/assistant/pending-decisions");
    expect(res.status).toBe(200);
    expect(res.body.decisions[0].canDecide).toBe(false);
  });

  it("reports canDecide true when the authority returns null (non-MK admin path)", async () => {
    // The real decision path substitutes "admin" for a null return — anyone
    // may decide in a company with no decision role. Null must not read as
    // a refusal.
    mockAuthorityService.requireDecisionActor.mockResolvedValue(null);
    const app = await createApp();
    const res = await request(app).get("/companies/company-1/assistant/pending-decisions");
    expect(res.status).toBe(200);
    expect(res.body.decisions[0].canDecide).toBe(true);
  });

  it("includes admin-decidable approvals with no requesting agent", async () => {
    mockApprovalService.list.mockResolvedValue([
      {
        id: "appr-board",
        companyId: "company-1",
        type: "budget_override_required",
        status: "pending",
        revision: 1,
        payload: {},
        requestedByAgentId: null,
        createdAt: new Date("2026-09-23T03:00:00Z"),
      },
    ]);
    const app = await createApp();
    const res = await request(app).get("/companies/company-1/assistant/pending-decisions");
    expect(res.status).toBe(200);
    expect(res.body.decisions).toHaveLength(1);
    expect(res.body.decisions[0].approvalId).toBe("appr-board");
    expect(res.body.decisions[0].askedBy).toBeNull();
    expect(res.body.decisions[0].summary).toMatch(/The board asks to/);
  });

  it("orders most urgent first — risk band, then longest waiting", async () => {
    mockSummarizeApprovalRisk.mockImplementation(
      (type: string) => ({ level: type === "hire_agent" ? "high" : "low" }),
    );
    mockApprovalService.list.mockResolvedValue([
      {
        id: "appr-low-old",
        companyId: "company-1",
        type: "send_email",
        status: "pending",
        revision: 1,
        payload: {},
        requestedByAgentId: "agent-1",
        createdAt: new Date("2026-09-20T01:00:00Z"),
      },
      {
        id: "appr-high-new",
        companyId: "company-1",
        type: "hire_agent",
        status: "pending",
        revision: 1,
        payload: {},
        requestedByAgentId: "agent-1",
        createdAt: new Date("2026-09-23T01:00:00Z"),
      },
    ]);
    const app = await createApp();
    const res = await request(app).get("/companies/company-1/assistant/pending-decisions");
    expect(res.status).toBe(200);
    expect(res.body.decisions.map((d: { approvalId: string }) => d.approvalId)).toEqual([
      "appr-high-new",
      "appr-low-old",
    ]);
  });

  it("returns tasks assigned to the calling person alongside decisions", async () => {
    mockDigestService.tasksAssignedTo.mockResolvedValue({
      manual: {
        total: 2,
        items: [
          { issueId: "issue-9", identifier: "ACME-313", title: "Pick the launch date", status: "todo", updatedAt: "2026-09-23T09:00:00Z" },
          { issueId: "issue-10", identifier: "ACME-314", title: "Sign the vendor contract", status: "in_progress", updatedAt: "2026-09-23T08:00:00Z" },
        ],
      },
      other: {
        total: 1,
        items: [
          { issueId: "issue-11", identifier: "ACME-315", title: "Weekly metrics snapshot", status: "todo", updatedAt: "2026-09-23T07:00:00Z", originKind: "routine_execution" },
        ],
      },
    });
    const app = await createApp();
    const res = await request(app).get("/companies/company-1/assistant/pending-decisions");
    expect(res.status).toBe(200);
    expect(mockDigestService.tasksAssignedTo).toHaveBeenCalledWith("company-1", "user-1");
    expect(res.body.tasksAssignedToYouTotal).toBe(2);
    expect(res.body.tasksAssignedToYou).toHaveLength(2);
    expect(res.body.tasksAssignedToYou[0].identifier).toBe("ACME-313");
    // Machine-filed assignments travel in their own group — the badge and
    // the Decisions main list must never count them.
    expect(res.body.otherTasksAssignedToYouTotal).toBe(1);
    expect(res.body.otherTasksAssignedToYou[0].identifier).toBe("ACME-315");
  });

  it("passes a null user id for a user-less actor so every human-assigned task counts", async () => {
    const app = await createApp({
      type: "board",
      userId: null,
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: true,
    });
    const res = await request(app).get("/companies/company-1/assistant/pending-decisions");
    expect(res.status).toBe(200);
    expect(mockDigestService.tasksAssignedTo).toHaveBeenCalledWith("company-1", null);
  });
});
