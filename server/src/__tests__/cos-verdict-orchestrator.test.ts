// Phase H — cos-verdict-orchestrator outbound tests.
//
// Mirrors the vi.mock + db-stub pattern used by the other goals-eval-hitl
// unit tests in this directory. Drives the orchestrator's externally-visible
// surface (enqueueForReview / dequeue / runReviewCycle / onIssueStatusChanged
// / escalateToHuman) with stubbed Drizzle chains.
//
// Production code is NOT modified; we wire the orchestrator with explicit
// `deps` so verdicts/featureFlags/autoHire are vi-mocks.
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
  setPluginEventBus: vi.fn(),
  publishPluginDomainEvent: vi.fn(),
}));

// issueApprovalService is a factory called inside the orchestrator's closure;
// stub it so we can assert link() invocations cleanly.
const mockIssueApprovalLink = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../services/issue-approvals.js", () => ({
  issueApprovalService: vi.fn(() => ({
    link: mockIssueApprovalLink,
    unlink: vi.fn(),
    linkManyForApproval: vi.fn(),
  })),
}));

import { cosVerdictOrchestrator } from "../services/cos-verdict-orchestrator.ts";

const C = "11111111-1111-1111-1111-111111111111";
const ISSUE_ID = "22222222-2222-2222-2222-222222222222";
const REVIEWER_AGENT = "33333333-3333-3333-3333-333333333333";
const APPROVAL_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const VERDICT_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

interface DbStub {
  /** Sequence of result rows to return for each .select() call. */
  selectQueue: unknown[][];
  inserts: Array<{ table: string; values: Record<string, unknown> }>;
  deletes: Array<{ table: string }>;
  /** Optional override for the row returned by .insert(approvals).returning(). */
  approvalReturning?: () => unknown[];
}

function makeDb(stub: DbStub) {
  const selectQueue = [...stub.selectQueue];

  const select = vi.fn(() => {
    const result = selectQueue.shift() ?? [];
    const chain: any = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.orderBy = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject);
    return chain;
  });

  // Tracks the last insert table so .returning() can dispatch correctly.
  let lastInsertTable: string | null = null;
  const insertReturning = vi.fn(async () => {
    if (lastInsertTable === "approvals") {
      return stub.approvalReturning?.() ?? [
        { id: APPROVAL_ID, status: "pending", payload: { type: "verdict_escalation" } },
      ];
    }
    return [];
  });

  const insertValuesFn = (values: Record<string, unknown>) => {
    stub.inserts.push({ table: lastInsertTable!, values });
    return {
      returning: insertReturning,
      onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    };
  };

  const insert = vi.fn((table: any) => {
    // Drizzle table objects expose Symbol(drizzle:Name); fall back to a
    // best-effort stringify so we can route returning() correctly.
    const name =
      table?._?.name ??
      table?.name ??
      String(table?.[Symbol.for("drizzle:Name")] ?? "");
    if (typeof name === "string" && name.toLowerCase().includes("approval")) {
      lastInsertTable = "approvals";
    } else if (typeof name === "string" && name.toLowerCase().includes("queue")) {
      lastInsertTable = "issue_review_queue_state";
    } else {
      lastInsertTable = "unknown";
    }
    return { values: insertValuesFn };
  });

  const del = vi.fn(() => {
    stub.deletes.push({ table: "issue_review_queue_state" });
    const chain: any = {};
    chain.where = vi.fn(() => chain);
    chain.returning = vi.fn(async () => [{ issueId: ISSUE_ID }]);
    return chain;
  });

  return { select, insert, delete: del } as any;
}

function makeDeps(over: Partial<{
  closing: unknown;
  createReturns: { id: string };
  createThrows: Error | null;
  evaluateAndHireMock: ReturnType<typeof vi.fn>;
}> = {}) {
  const evaluateAndHireIfNeeded = over.evaluateAndHireMock ?? vi.fn().mockResolvedValue({ hired: false });
  const closingVerdictFor = vi.fn().mockResolvedValue(over.closing ?? null);
  const createMock = vi.fn();
  if (over.createThrows) {
    createMock.mockRejectedValue(over.createThrows);
  } else {
    createMock.mockResolvedValue(over.createReturns ?? { id: VERDICT_ID });
  }
  return {
    verdicts: {
      closingVerdictFor,
      create: createMock,
    } as any,
    featureFlags: {
      isEnabled: vi.fn().mockResolvedValue(true),
      set: vi.fn(),
      get: vi.fn(),
      listForCompany: vi.fn(),
    } as any,
    autoHire: {
      evaluateAndHireIfNeeded,
    } as any,
  };
}

beforeEach(() => {
  mockLogActivity.mockClear();
  mockIssueApprovalLink.mockClear();
  delete process.env.AGENTDASH_VERDICT_ESCALATE_AFTER_MS;
});

// ---------------------------------------------------------------------------
// enqueueForReview
// ---------------------------------------------------------------------------

describe("cosVerdictOrchestrator.enqueueForReview", () => {
  it("inserts queue row, picks oldest active reviewer, and triggers queue_depth auto-hire", async () => {
    const stub: DbStub = {
      // 1st select: pickAvailableReviewer returns one row.
      selectQueue: [[{ reviewerAgentId: REVIEWER_AGENT }]],
      inserts: [],
      deletes: [],
    };
    const db = makeDb(stub);
    const deps = makeDeps();
    const orch = cosVerdictOrchestrator(db, deps);

    await orch.enqueueForReview(C, ISSUE_ID);

    // Insert into issue_review_queue_state happened.
    const queueInsert = stub.inserts.find((i) => i.table === "issue_review_queue_state");
    expect(queueInsert).toBeDefined();
    expect(queueInsert!.values).toMatchObject({
      issueId: ISSUE_ID,
      companyId: C,
      assignedReviewerAgentId: REVIEWER_AGENT,
    });
    expect(queueInsert!.values.escalateAfter).toBeInstanceOf(Date);
    expect(queueInsert!.values.enqueuedAt).toBeInstanceOf(Date);

    // Auto-hire is ALWAYS evaluated after enqueue (depth-growth check).
    expect(deps.autoHire.evaluateAndHireIfNeeded).toHaveBeenCalledTimes(1);
    expect(deps.autoHire.evaluateAndHireIfNeeded).toHaveBeenCalledWith(C, "queue_depth");

    // Activity log row written.
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity.mock.calls[0]![1]).toMatchObject({
      action: "queue_state_changed",
      details: { op: "enqueue" },
    });
  });

  it("leaves assignedReviewerAgentId null when no reviewer exists, still triggers auto-hire", async () => {
    const stub: DbStub = {
      selectQueue: [[]], // no active reviewers
      inserts: [],
      deletes: [],
    };
    const db = makeDb(stub);
    const deps = makeDeps();
    const orch = cosVerdictOrchestrator(db, deps);

    await orch.enqueueForReview(C, ISSUE_ID);

    const queueInsert = stub.inserts.find((i) => i.table === "issue_review_queue_state");
    expect(queueInsert!.values.assignedReviewerAgentId).toBeNull();
    expect(deps.autoHire.evaluateAndHireIfNeeded).toHaveBeenCalledWith(C, "queue_depth");
  });

  it("uses AGENTDASH_VERDICT_ESCALATE_AFTER_MS env override when set", async () => {
    process.env.AGENTDASH_VERDICT_ESCALATE_AFTER_MS = "60000"; // 60 seconds
    const stub: DbStub = {
      selectQueue: [[{ reviewerAgentId: REVIEWER_AGENT }]],
      inserts: [],
      deletes: [],
    };
    const db = makeDb(stub);
    const deps = makeDeps();
    const orch = cosVerdictOrchestrator(db, deps);

    const before = Date.now();
    await orch.enqueueForReview(C, ISSUE_ID);
    const after = Date.now();

    const queueInsert = stub.inserts.find((i) => i.table === "issue_review_queue_state");
    const escalateAfter = (queueInsert!.values.escalateAfter as Date).getTime();
    const enqueuedAt = (queueInsert!.values.enqueuedAt as Date).getTime();
    expect(escalateAfter - enqueuedAt).toBe(60000);
    // Sanity: enqueue happened in the test window.
    expect(enqueuedAt).toBeGreaterThanOrEqual(before);
    expect(enqueuedAt).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// onIssueStatusChanged
// ---------------------------------------------------------------------------

describe("cosVerdictOrchestrator.onIssueStatusChanged", () => {
  it("enqueues when next status is in_review", async () => {
    const stub: DbStub = {
      // First select: lookup issue companyId. Second: pickAvailableReviewer.
      selectQueue: [[{ id: ISSUE_ID, companyId: C }], [{ reviewerAgentId: REVIEWER_AGENT }]],
      inserts: [],
      deletes: [],
    };
    const db = makeDb(stub);
    const deps = makeDeps();
    const orch = cosVerdictOrchestrator(db, deps);

    await orch.onIssueStatusChanged(ISSUE_ID, "in_progress", "in_review");

    expect(stub.inserts.find((i) => i.table === "issue_review_queue_state")).toBeDefined();
  });

  it("dequeues when next status is done", async () => {
    const stub: DbStub = {
      selectQueue: [[{ id: ISSUE_ID, companyId: C }]],
      inserts: [],
      deletes: [],
    };
    const db = makeDb(stub);
    const deps = makeDeps();
    const orch = cosVerdictOrchestrator(db, deps);

    await orch.onIssueStatusChanged(ISSUE_ID, "in_review", "done");

    expect(stub.deletes).toHaveLength(1);
    expect(stub.inserts).toHaveLength(0);
  });

  it("dequeues when next status is cancelled", async () => {
    const stub: DbStub = {
      selectQueue: [[{ id: ISSUE_ID, companyId: C }]],
      inserts: [],
      deletes: [],
    };
    const db = makeDb(stub);
    const deps = makeDeps();
    const orch = cosVerdictOrchestrator(db, deps);

    await orch.onIssueStatusChanged(ISSUE_ID, "in_review", "cancelled");
    expect(stub.deletes).toHaveLength(1);
  });

  it("is a no-op for transitions that aren't enqueue/dequeue triggers", async () => {
    const stub: DbStub = {
      selectQueue: [[{ id: ISSUE_ID, companyId: C }]],
      inserts: [],
      deletes: [],
    };
    const db = makeDb(stub);
    const deps = makeDeps();
    const orch = cosVerdictOrchestrator(db, deps);

    await orch.onIssueStatusChanged(ISSUE_ID, "todo", "in_progress");
    expect(stub.inserts).toHaveLength(0);
    expect(stub.deletes).toHaveLength(0);
    expect(deps.autoHire.evaluateAndHireIfNeeded).not.toHaveBeenCalled();
  });

  it("returns silently if the issue can't be found", async () => {
    const stub: DbStub = {
      selectQueue: [[]], // no issue row
      inserts: [],
      deletes: [],
    };
    const db = makeDb(stub);
    const deps = makeDeps();
    const orch = cosVerdictOrchestrator(db, deps);

    await orch.onIssueStatusChanged("missing", "in_progress", "in_review");
    expect(stub.inserts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runReviewCycle
// ---------------------------------------------------------------------------

describe("cosVerdictOrchestrator.runReviewCycle", () => {
  it("dequeues items where a closing verdict already exists", async () => {
    const queueRow = {
      issueId: ISSUE_ID,
      companyId: C,
      enqueuedAt: new Date(Date.now() - 10_000),
      escalateAfter: new Date(Date.now() + 10_000),
      assignedReviewerAgentId: REVIEWER_AGENT,
    };
    const stub: DbStub = {
      selectQueue: [[queueRow]],
      inserts: [],
      deletes: [],
    };
    const db = makeDb(stub);
    const deps = makeDeps({ closing: { id: "v-prior" } });
    const orch = cosVerdictOrchestrator(db, deps);

    await orch.runReviewCycle(C);

    expect(deps.verdicts.closingVerdictFor).toHaveBeenCalledWith(C, "issue", ISSUE_ID);
    expect(stub.deletes).toHaveLength(1);
    // No verdict creation, no approval insert.
    expect(deps.verdicts.create).not.toHaveBeenCalled();
    expect(stub.inserts.find((i) => i.table === "approvals")).toBeUndefined();
  });

  it("no-ops items that are not yet past escalateAfter and have no closing verdict", async () => {
    const queueRow = {
      issueId: ISSUE_ID,
      companyId: C,
      enqueuedAt: new Date(),
      escalateAfter: new Date(Date.now() + 60_000), // 60s in future
      assignedReviewerAgentId: REVIEWER_AGENT,
    };
    const stub: DbStub = {
      selectQueue: [[queueRow]],
      inserts: [],
      deletes: [],
    };
    const db = makeDb(stub);
    const deps = makeDeps();
    const orch = cosVerdictOrchestrator(db, deps);

    await orch.runReviewCycle(C);
    expect(stub.deletes).toHaveLength(0);
    expect(deps.verdicts.create).not.toHaveBeenCalled();
    expect(stub.inserts.find((i) => i.table === "approvals")).toBeUndefined();
  });

  it("escalates items past escalateAfter — writes verdict + approval + issue_approval link + activity row", async () => {
    const queueRow = {
      issueId: ISSUE_ID,
      companyId: C,
      enqueuedAt: new Date(Date.now() - 60_000),
      escalateAfter: new Date(Date.now() - 1000), // expired
      assignedReviewerAgentId: REVIEWER_AGENT,
    };
    const stub: DbStub = {
      // 1st select: queue rows. 2nd: closingVerdictFor inside escalateToHuman
      // (we mocked deps.verdicts.closingVerdictFor so this never hits db — but
      // be defensive in case the orchestrator changes).
      selectQueue: [[queueRow]],
      inserts: [],
      deletes: [],
    };
    const db = makeDb(stub);
    const deps = makeDeps({ closing: null });
    const orch = cosVerdictOrchestrator(db, deps);

    await orch.runReviewCycle(C);

    // Verdict was created with escalated_to_human outcome.
    expect(deps.verdicts.create).toHaveBeenCalledTimes(1);
    expect(deps.verdicts.create.mock.calls[0]![0]).toMatchObject({
      companyId: C,
      entityType: "issue",
      issueId: ISSUE_ID,
      reviewerAgentId: REVIEWER_AGENT,
      outcome: "escalated_to_human",
    });

    // Approval row inserted with type=verdict_escalation, payload references verdict + issue.
    const approvalInsert = stub.inserts.find((i) => i.table === "approvals");
    expect(approvalInsert).toBeDefined();
    expect(approvalInsert!.values).toMatchObject({
      companyId: C,
      type: "verdict_escalation",
      requestedByAgentId: REVIEWER_AGENT,
      status: "pending",
    });
    const payload = approvalInsert!.values.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      type: "verdict_escalation",
      verdictId: VERDICT_ID,
      issueId: ISSUE_ID,
    });

    // Issue↔approval link was created.
    expect(mockIssueApprovalLink).toHaveBeenCalledWith(ISSUE_ID, APPROVAL_ID, {
      agentId: REVIEWER_AGENT,
    });

    // Activity row recorded for the escalation.
    const escalations = mockLogActivity.mock.calls.filter(
      (c) => c[1]?.action === "verdict_escalated",
    );
    expect(escalations).toHaveLength(1);
    expect(escalations[0]![1]).toMatchObject({
      details: { reason: "sla_expired", verdictId: VERDICT_ID, approvalId: APPROVAL_ID },
    });
  });

  it("kicks neutrality_conflict auto-hire when reviewer becomes null between enqueue and tick", async () => {
    // Simulate the orchestrator finding a queue row but assignedReviewerAgentId
    // is null (e.g. all reviewers retired between enqueue and tick).
    const queueRow = {
      issueId: ISSUE_ID,
      companyId: C,
      enqueuedAt: new Date(Date.now() - 60_000),
      escalateAfter: new Date(Date.now() - 1000),
      assignedReviewerAgentId: null,
    };
    // findEscalatable() / runReviewCycle's main query filters on
    // `isNotNull(assignedReviewerAgentId)`, so to exercise the neutrality-
    // fallback path we exercise escalateToHuman() directly with a null
    // reviewer (the public API exposes it for tests / orchestrator entry).
    const stub: DbStub = {
      selectQueue: [],
      inserts: [],
      deletes: [],
    };
    void queueRow;
    const db = makeDb(stub);
    const deps = makeDeps();
    const orch = cosVerdictOrchestrator(db, deps);

    await orch.escalateToHuman(C, ISSUE_ID, null);

    expect(deps.autoHire.evaluateAndHireIfNeeded).toHaveBeenCalledWith(
      C,
      "neutrality_conflict",
    );
    // No verdict / approval written when we bail to neutrality_conflict.
    expect(deps.verdicts.create).not.toHaveBeenCalled();
    expect(stub.inserts.find((i) => i.table === "approvals")).toBeUndefined();
  });

  it("converts NEUTRAL_VALIDATOR_VIOLATION into neutrality_conflict auto-hire trigger", async () => {
    const queueRow = {
      issueId: ISSUE_ID,
      companyId: C,
      enqueuedAt: new Date(Date.now() - 60_000),
      escalateAfter: new Date(Date.now() - 1000),
      assignedReviewerAgentId: REVIEWER_AGENT,
    };
    const stub: DbStub = {
      selectQueue: [[queueRow]],
      inserts: [],
      deletes: [],
    };
    const db = makeDb(stub);
    const neutralErr = new Error("reviewer must not be the assignee");
    const deps = makeDeps({ createThrows: neutralErr });
    const orch = cosVerdictOrchestrator(db, deps);

    await orch.runReviewCycle(C);

    expect(deps.autoHire.evaluateAndHireIfNeeded).toHaveBeenCalledWith(
      C,
      "neutrality_conflict",
    );
    // No approval row was written because verdict creation aborted.
    expect(stub.inserts.find((i) => i.table === "approvals")).toBeUndefined();
  });
});
