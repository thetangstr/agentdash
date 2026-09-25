// AgentDash: goals-eval-hitl — GET /api/companies/:companyId/issues
// ?reviewerAgentId=me resolves to the calling agent so a CoS reviewer can
// list exactly the queue items assigned to it; non-agent callers get 403 and
// a literal reviewer id stays a company-scoped read-only filter.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const reviewerAgentId = "33333333-3333-4333-8333-333333333333";
const otherReviewerId = "44444444-4444-4444-8444-444444444444";

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(async () => []),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  get: vi.fn(async () => ({
    id: "instance-settings-1",
    general: {
      censorUsernameInLogs: false,
      feedbackDataSharingPreference: "prompt",
    },
  })),
  listCompanyIds: vi.fn(async () => [companyId]),
}));

vi.mock("../services/index.js", () => ({
  agentRunService: vi.fn().mockReturnValue({ recordRun: vi.fn(), monthlyCount: vi.fn(), monthlyCountByAgent: vi.fn() }),
  agentInstructionRefreshService: () => ({ refreshForAgent: vi.fn(), refreshForRole: vi.fn() }),
  ISSUE_LIST_DEFAULT_LIMIT: 50,
  companyService: () => ({
    hasActiveCompany: vi.fn().mockResolvedValue(true),
    getById: vi.fn(async () => ({ id: companyId })),
  }),
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  documentService: () => ({}),
  environmentService: () => ({}),
  executionWorkspaceService: () => ({}),
  feedbackService: () => ({
    listIssueVotesForUser: vi.fn(async () => []),
    saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
  }),
  goalService: () => ({}),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
  }),
  instanceSettingsService: () => mockInstanceSettingsService,
  issueApprovalService: () => ({}),
  issueReferenceService: () => ({
    deleteDocumentSource: vi.fn(async () => undefined),
    diffIssueReferenceSummary: vi.fn(() => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    })),
    emptySummary: vi.fn(() => ({ outbound: [], inbound: [] })),
    listIssueReferenceSummary: vi.fn(async () => ({ outbound: [], inbound: [] })),
    syncComment: vi.fn(async () => undefined),
    syncDocument: vi.fn(async () => undefined),
    syncIssue: vi.fn(async () => undefined),
  }),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({}),
  routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
  workProductService: () => ({}),
}));

vi.mock("../services/execution-workspaces.js", () => ({
  executionWorkspaceService: () => ({}),
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  // projectScopedVisibilityCondition consults project visibility directly.
  const dbStub = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([]),
      }),
    }),
  };
  app.use("/api", issueRoutes(dbStub as any, {} as any));
  app.use(errorHandler);
  return app;
}

const agentActor = {
  type: "agent",
  agentId: reviewerAgentId,
  companyId,
  runId: "55555555-5555-4555-8555-555555555555",
};

const boardActor = {
  type: "board",
  userId: "local-board",
  companyIds: [companyId],
  source: "local_implicit",
  isInstanceAdmin: false,
};

beforeEach(() => {
  mockIssueService.list.mockClear();
});

describe("GET /companies/:companyId/issues ?reviewerAgentId", () => {
  it("reviewerAgentId=me resolves to the calling agent", async () => {
    const res = await request(createApp(agentActor))
      .get(`/api/companies/${companyId}/issues?status=in_review&reviewerAgentId=me`);

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledTimes(1);
    expect(mockIssueService.list.mock.calls[0]![0]).toBe(companyId);
    expect(mockIssueService.list.mock.calls[0]![1]).toMatchObject({
      status: "in_review",
      reviewerAgentId,
    });
  });

  it("reviewerAgentId=me rejects non-agent callers with 403", async () => {
    const res = await request(createApp(boardActor))
      .get(`/api/companies/${companyId}/issues?status=in_review&reviewerAgentId=me`);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/reviewerAgentId=me/);
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });

  it("a literal reviewerAgentId is passed through as a read-only filter", async () => {
    const res = await request(createApp(boardActor))
      .get(`/api/companies/${companyId}/issues?status=in_review&reviewerAgentId=${otherReviewerId}`);

    expect(res.status).toBe(200);
    expect(mockIssueService.list.mock.calls[0]![1]).toMatchObject({
      reviewerAgentId: otherReviewerId,
    });
  });

  it("an agent cannot use reviewerAgentId=me to read another company's queue", async () => {
    const foreign = "66666666-6666-4666-8666-666666666666";
    const res = await request(createApp(agentActor))
      .get(`/api/companies/${foreign}/issues?status=in_review&reviewerAgentId=me`);

    expect(res.status).toBe(403);
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });

  it("GH #701: a non-UUID literal reviewerAgentId is rejected with 400, not a 500", async () => {
    // Before the fix the raw string reached the SQL uuid cast and surfaced
    // as "invalid input syntax for type uuid" → 500.
    const res = await request(createApp(boardActor))
      .get(`/api/companies/${companyId}/issues?status=in_review&reviewerAgentId=not-a-uuid`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reviewerAgentId must be a UUID/);
    expect(mockIssueService.list).not.toHaveBeenCalled();
  });

  it("GH #701: reviewerAgentId=me bypasses the UUID check (agent actor)", async () => {
    const res = await request(createApp(agentActor))
      .get(`/api/companies/${companyId}/issues?status=in_review&reviewerAgentId=me`);

    expect(res.status).toBe(200);
    expect(mockIssueService.list).toHaveBeenCalledTimes(1);
  });
});
