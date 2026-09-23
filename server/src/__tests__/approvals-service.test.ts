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
    mockAgentService.activatePendingApproval.mockResolvedValue(undefined);
    mockAgentService.getById.mockResolvedValue({ id: "agent-1", companyId: "company-1" });
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
});

describe("approvalService autoProvisionDefaultKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.activatePendingApproval.mockResolvedValue(undefined);
    mockAgentService.getById.mockResolvedValue({ id: "agent-1", companyId: "company-1" });
    mockAgentService.terminate.mockResolvedValue(undefined);
    mockAgentService.listKeys.mockResolvedValue([]);
    mockAgentService.createApiKey.mockResolvedValue({ id: "key-1" });
    mockNotifyHireApproved.mockResolvedValue(undefined);
  });

  function approvalWithKeyFlag(flag: boolean): ApprovalRecord {
    return {
      ...createApproval("pending"),
      payload: { agentId: "agent-1", autoProvisionDefaultKey: flag },
    };
  }

  it("mints a default API key at activation when the payload asks for one", async () => {
    const approved = { ...approvalWithKeyFlag(true), status: "approved" };
    const dbStub = createDbStub([[approvalWithKeyFlag(true)]], [approved]);

    const svc = approvalService(dbStub.db as any);
    const result = await svc.approve("approval-1", "board", "ship it");

    expect(result.applied).toBe(true);
    expect(mockAgentService.createApiKey).toHaveBeenCalledWith(
      "agent-1",
      "default",
      expect.objectContaining({ source: "auto_hire" }),
    );
  });

  it("does not mint a second default key when one is already live", async () => {
    mockAgentService.listKeys.mockResolvedValue([
      { id: "key-0", name: "default", revokedAt: null },
    ]);
    const approved = { ...approvalWithKeyFlag(true), status: "approved" };
    const dbStub = createDbStub([[approvalWithKeyFlag(true)]], [approved]);

    const svc = approvalService(dbStub.db as any);
    await svc.approve("approval-1", "board", "ship it");

    expect(mockAgentService.createApiKey).not.toHaveBeenCalled();
  });

  it("does not mint a key when the payload did not ask for one", async () => {
    const approved = createApproval("approved");
    const dbStub = createDbStub([[createApproval("pending")]], [approved]);

    const svc = approvalService(dbStub.db as any);
    await svc.approve("approval-1", "board", "ship it");

    expect(mockAgentService.createApiKey).not.toHaveBeenCalled();
  });
});
