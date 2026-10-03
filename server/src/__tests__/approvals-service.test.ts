import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalService } from "../services/approvals.ts";

const mockAgentService = vi.hoisted(() => ({
  activatePendingApproval: vi.fn(),
  // Hire lifecycle effects now confirm the payload agent is in the approval's
  // company before acting, so the mock must answer that lookup.
  getById: vi.fn(),
  terminate: vi.fn(),
  create: vi.fn(),
  listKeys: vi.fn(),
  createApiKey: vi.fn(),
}));

const mockNotifyHireApproved = vi.hoisted(() => vi.fn());

vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => mockAgentService),
}));

vi.mock("../services/hire-hook.js", () => ({
  notifyHireApproved: mockNotifyHireApproved,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: vi.fn(() => ({
    getGeneral: async () => ({ censorUsernameInLogs: false }),
  })),
}));

type ApprovalRecord = {
  id: string;
  companyId: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  requestedByAgentId: string | null;
};

function createApproval(status: string): ApprovalRecord {
  return {
    id: "approval-1",
    companyId: "company-1",
    type: "hire_agent",
    status,
    payload: { agentId: "agent-1" },
    requestedByAgentId: "requester-1",
  };
}

function createDbStub(selectResults: ApprovalRecord[][], updateResults: ApprovalRecord[]) {
  const pendingSelectResults = [...selectResults];
  const selectWhere = vi.fn(async () => pendingSelectResults.shift() ?? []);
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));

  const returning = vi.fn(async () => updateResults);
  const updateWhere = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));

  return {
    db: { select, update },
    selectWhere,
    returning,
  };
}

describe("approvalService resolution idempotency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.activatePendingApproval.mockResolvedValue({ activated: true });
    // A hire approval is about an agent still waiting on it; reject now
    // refuses one whose agent is already running, so the fixture says which.
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      name: "Hire",
      status: "pending_approval",
    });
    mockAgentService.terminate.mockResolvedValue(undefined);
    mockAgentService.create.mockResolvedValue({ id: "agent-1" });
    mockAgentService.terminate.mockResolvedValue(undefined);
    mockAgentService.listKeys.mockResolvedValue([]);
    mockAgentService.createApiKey.mockResolvedValue({ id: "key-1" });
    mockNotifyHireApproved.mockResolvedValue(undefined);
  });

  it("treats repeated approve retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("approved")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("approved");
    expect(mockAgentService.activatePendingApproval).not.toHaveBeenCalled();
    expect(mockNotifyHireApproved).not.toHaveBeenCalled();
  });

  it("treats repeated reject retries as no-ops after another worker resolves the approval", async () => {
    const dbStub = createDbStub(
      [[createApproval("pending")], [createApproval("rejected")]],
      [],
    );

    const svc = approvalService(dbStub.db as any);
    const result = await svc.reject("approval-1", "board", "not now");

    expect(result.applied).toBe(false);
    expect(result.approval.status).toBe("rejected");
    expect(mockAgentService.terminate).not.toHaveBeenCalled();
  });

  it("still performs side effects when the resolution update is newly applied", async () => {
    const approved = createApproval("approved");
    const dbStub = createDbStub([[createApproval("pending")]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.activatePendingApproval).toHaveBeenCalledWith("agent-1");
    expect(mockNotifyHireApproved).toHaveBeenCalledTimes(1);
  });

  it("refuses to reject a hire whose agent is already active, before writing the decision", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      companyId: "company-1",
      name: "Helper",
      status: "idle",
    });
    const dbStub = createDbStub([[createApproval("pending")]], [createApproval("rejected")]);

    const svc = approvalService(dbStub.db as any);
    await expect(svc.reject("approval-1", "board", "stale")).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/Helper is already active/),
    });

    expect(dbStub.returning).not.toHaveBeenCalled();
    expect(mockAgentService.terminate).not.toHaveBeenCalled();
  });

  it("threads the decider through to a termination conditional on the agent still pending", async () => {
    const dbStub = createDbStub([[createApproval("pending")]], [createApproval("rejected")]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.reject("approval-1", "user-7", "no");

    expect(result.applied).toBe(true);
    expect(mockAgentService.terminate).toHaveBeenCalledWith("agent-1", {
      endedByUserId: "user-7",
      onlyIfStatus: "pending_approval",
    });
  });

  it("does not re-run the budget policy or hire hook when the agent was already activated", async () => {
    // Deciding a hire approval after the agent was activated from its own
    // page: activation is a no-op, and the lifecycle side effects already
    // belong to that earlier moment.
    mockAgentService.activatePendingApproval.mockResolvedValue({ activated: false });
    const dbStub = createDbStub([[createApproval("pending")]], [createApproval("approved")]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "record it");

    expect(result.applied).toBe(true);
    expect(mockNotifyHireApproved).not.toHaveBeenCalled();
  });
});

describe("approvalService comment redaction", () => {
  function createCommentDbStub(approval: ApprovalRecord) {
    const insertedBodies: string[] = [];
    const db = {
      select: () => ({
        from: () => ({ where: async () => [approval] }),
      }),
      insert: () => ({
        values: (values: { body: string }) => {
          insertedBodies.push(values.body);
          return { returning: async () => [{ id: "comment-1", body: values.body }] };
        },
      }),
    };
    return { db, insertedBodies };
  }

  it("persists agent-authored comments redacted and human comments raw", async () => {
    // GH #992: an agent comment is model output that can echo a credential;
    // a human's verbatim quote stays raw in the row (serving redacts again).
    const canary = "provk-appr-canary-7f3a9c2d4e5ab6c78d9e0f1a2b3c4d5e";
    const { db, insertedBodies } = createCommentDbStub(createApproval("pending"));
    const svc = approvalService(db as any);

    const agentComment = await svc.addComment("approval-1", `echo api_key=${canary}`, { agentId: "agent-1" });
    const humanComment = await svc.addComment("approval-1", `echo api_key=${canary}`, { userId: "user-1" });

    expect(insertedBodies[0]).not.toContain(canary);
    expect(insertedBodies[0]).toContain("***REDACTED***");
    expect(insertedBodies[1]).toContain(canary);
    // Both are safe as returned (the serve pass covers human comments too).
    expect(agentComment.body).not.toContain(canary);
    expect(humanComment.body).not.toContain(canary);
  });
});

describe("approvalService legacy autoProvisionDefaultKey payloads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.activatePendingApproval.mockResolvedValue(undefined);
    mockAgentService.getById.mockResolvedValue({ id: "agent-1", companyId: "company-1" });
    mockAgentService.terminate.mockResolvedValue(undefined);
    mockAgentService.listKeys.mockResolvedValue([]);
    mockAgentService.createApiKey.mockResolvedValue({ id: "key-1" });
    mockNotifyHireApproved.mockResolvedValue(undefined);
  });

  it("ignores a stale autoProvisionDefaultKey flag — approve never mints keys", async () => {
    // The flag was removed: runtime auth is the run-scoped local agent JWT the
    // heartbeat injects, and the route rejects new payloads carrying it. A
    // payload persisted while the flag existed must not mint one now.
    const pending = {
      ...createApproval("pending"),
      payload: { agentId: "agent-1", autoProvisionDefaultKey: true },
    };
    const approved = { ...pending, status: "approved" };
    const dbStub = createDbStub([[pending]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.activatePendingApproval).toHaveBeenCalledWith("agent-1");
    expect(mockAgentService.listKeys).not.toHaveBeenCalled();
    expect(mockAgentService.createApiKey).not.toHaveBeenCalled();
  });
});
