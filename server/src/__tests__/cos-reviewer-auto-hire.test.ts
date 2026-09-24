// Phase H3 — reviewer auto-hire convergence + neutrality-conflict unit tests,
// extended for the runnable/approval-gated reviewer fix.
//
// We mock agentService.create via the deps.createAgent injection point and
// drive db.transaction to call its callback inline. The convergence guard
// (FOR UPDATE) is exercised by sequencing the SELECT-active result so that
// the second concurrent call observes the first hire.
//
// Slot rows are shaped like the join the service now performs:
//   { assignment: <cos_reviewer_assignments row>, agentStatus: <agents.status> }
// The SQL WHERE excludes retired + terminated rows, so fixtures model the
// post-filter set; JS-side assertions cover the runnable-vs-slot split.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
  setPluginEventBus: vi.fn(),
  publishPluginDomainEvent: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  createApiKey: vi.fn(),
}));
vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => mockAgentService),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
}));
vi.mock("../services/approvals.js", () => ({
  approvalService: vi.fn(() => mockApprovalService),
}));

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
vi.mock("../services/companies.js", () => ({
  companyService: vi.fn(() => mockCompanyService),
}));

vi.mock("../services/cos-replier.js", () => ({
  defaultAgentPlanAdapterType: vi.fn(() => "claude-local"),
}));

const mockInstructions = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
}));
vi.mock("../services/agent-instructions.js", () => ({
  agentInstructionsService: vi.fn(() => mockInstructions),
}));

const mockLoadBundle = vi.hoisted(() => vi.fn());
vi.mock("../services/default-agent-instructions.js", () => ({
  loadDefaultAgentInstructionsBundle: mockLoadBundle,
}));

import { cosReviewerAutoHire } from "../services/cos-reviewer-auto-hire.ts";

const C = "11111111-1111-1111-1111-111111111111";
const originalStripeSecretKey = process.env.STRIPE_SECRET_KEY;
const originalBillingDisabled = process.env.AGENTDASH_BILLING_DISABLED;

interface SlotRow {
  assignment: { id: string; reviewerAgentId: string };
  agentStatus: string;
}

function slotRow(id: string, agentId: string, agentStatus: string): SlotRow {
  return { assignment: { id, reviewerAgentId: agentId }, agentStatus };
}

interface DbScript {
  /** Sequence of slot rows returned by tx.select().for("update") (live assignments). */
  activeReviewerSeq: SlotRow[][];
  /** Sequence of rows returned by tx.select().from(issueReviewQueueState).where(...) -> [{value: number}]. */
  depthSeq: Array<{ value: number }>;
  /** Inserts collected so we can assert. */
  inserts: Array<{ table: string; values: Record<string, unknown> }>;
}

function makeDb(script: DbScript) {
  const insertedReviewers: Array<Record<string, unknown>> = [];

  // The auto-hire transaction issues:
  //  1) SELECT assignments JOIN agents WHERE companyId=? AND retiredAt IS NULL
  //     AND status != 'terminated' FOR UPDATE  — identified by .for("update")
  //  2) (queue_depth path only) SELECT count() FROM issue_review_queue_state
  const activeQ = [...script.activeReviewerSeq];
  const depthQ = [...script.depthSeq];

  const select = vi.fn(() => {
    let payload: unknown[] | null = null;
    let usedJoin = false;
    const chain: any = {};
    chain.from = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => {
      // Both assignment queries (the FOR UPDATE slot lock and the public
      // activeReviewers lookup) join agents; the depth count does not.
      usedJoin = true;
      return chain;
    });
    chain.where = vi.fn(() => chain);
    chain.for = vi.fn(() => {
      // Mark this as the live-assignments query.
      payload = activeQ.shift() ?? [];
      return chain;
    });
    chain.orderBy = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      if (payload === null) {
        if (usedJoin) {
          payload = activeQ.shift() ?? [];
        } else {
          // This must be the depth query.
          const next = depthQ.shift();
          payload = next ? [next] : [{ value: 0 }];
        }
      }
      return Promise.resolve(payload).then(resolve, reject);
    };
    return chain;
  });

  const insertReturning = vi.fn(async () => {
    const last = insertedReviewers[insertedReviewers.length - 1];
    return [
      {
        id: "assignment-" + insertedReviewers.length,
        companyId: C,
        reviewerAgentId: last?.reviewerAgentId,
        queueDepthAtSpawn: last?.queueDepthAtSpawn ?? null,
        retiredAt: null,
        hiredAt: new Date(),
      },
    ];
  });
  const insertValues = vi.fn((values: Record<string, unknown>) => {
    insertedReviewers.push(values);
    script.inserts.push({ table: "cos_reviewer_assignments", values });
    return { returning: insertReturning };
  });

  const db: any = {
    execute: vi.fn().mockResolvedValue([]),
    select,
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })) })),
  };
  db.transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));

  return db;
}

beforeEach(() => {
  mockLogActivity.mockClear();
  mockAgentService.create.mockReset();
  mockAgentService.list.mockReset();
  mockAgentService.getById.mockReset();
  mockAgentService.update.mockReset();
  mockAgentService.createApiKey.mockReset();
  mockApprovalService.create.mockReset();
  mockCompanyService.getById.mockReset();
  mockInstructions.materializeManagedBundle.mockReset();
  mockLoadBundle.mockReset();
  mockAgentService.list.mockResolvedValue([]);
  mockCompanyService.getById.mockResolvedValue({ id: C, planTier: "pro_active" });
  mockApprovalService.create.mockResolvedValue({ id: "approval-1", status: "pending" });
  mockLoadBundle.mockResolvedValue({ "AGENTS.md": "reviewer mandate" });
  mockInstructions.materializeManagedBundle.mockResolvedValue({
    bundle: {},
    adapterConfig: {
      instructionsBundle: { mode: "managed", rootPath: "/tmp/x", entryFile: "AGENTS.md" },
    },
  });
  delete process.env.AGENTDASH_REVIEWER_QUEUE_DEPTH_THRESHOLD;
  delete process.env.AGENTDASH_REVIEWER_MAX_CONCURRENT_HIRES;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.AGENTDASH_BILLING_DISABLED;
});

afterEach(() => {
  if (originalStripeSecretKey === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = originalStripeSecretKey;
  if (originalBillingDisabled === undefined) delete process.env.AGENTDASH_BILLING_DISABLED;
  else process.env.AGENTDASH_BILLING_DISABLED = originalBillingDisabled;
});

describe("cosReviewerAutoHire — approval-gated hire", () => {
  it("takes the per-company advisory lock before reading any counts", async () => {
    const db = makeDb({ activeReviewerSeq: [[]], depthSeq: [], inserts: [] });
    const svc = cosReviewerAutoHire(db, {
      createAgent: vi.fn().mockResolvedValue({ id: "agent-lock-1" }),
      provisionReviewer: vi.fn().mockResolvedValue(undefined),
    });

    await svc.evaluateAndHireIfNeeded(C, "neutrality_conflict");
    // The advisory lock (db.execute) must be issued before the first SELECT —
    // locking after the count is the race the guard exists to close.
    expect(db.execute).toHaveBeenCalled();
    expect(db.execute.mock.invocationCallOrder[0]!).toBeLessThan(
      (db.select as any).mock.invocationCallOrder[0]!,
    );
  });

  it("files a hire_agent approval for a pending_approval reviewer instead of hiring directly", async () => {
    const inserts: DbScript["inserts"] = [];
    const db = makeDb({
      activeReviewerSeq: [[]],
      depthSeq: [{ value: 0 }],
      inserts,
    });
    const provisionReviewer = vi.fn().mockResolvedValue(undefined);
    const svc = cosReviewerAutoHire(db, {
      createAgent: vi.fn().mockResolvedValue({ id: "agent-new-1" }),
      provisionReviewer,
    });

    const result = await svc.evaluateAndHireIfNeeded(C, "neutrality_conflict");
    expect(result.hired).toBe(true);
    expect(result.reason).toBe("approval_pending");
    expect(result.approvalId).toBe("approval-1");
    expect(result.reviewerAgentId).toBe("agent-new-1");
    // Assignment row still lands so the slot is reserved.
    expect(inserts).toHaveLength(1);
    // The approval is the same shape a user-initiated hire produces.
    expect(mockApprovalService.create).toHaveBeenCalledTimes(1);
    const approvalArg = mockApprovalService.create.mock.calls[0]![1] as Record<string, any>;
    expect(approvalArg.type).toBe("hire_agent");
    expect(approvalArg.status).toBe("pending");
    expect(approvalArg.payload.agentId).toBe("agent-new-1");
    expect(approvalArg.payload.autoHireReason).toBe("neutrality_conflict");
    // Provisioning ran after commit.
    expect(provisionReviewer).toHaveBeenCalledWith("agent-new-1");
    // Audit row: reviewer_hire_requested (was reviewer_hired before the gate).
    const hireCalls = mockLogActivity.mock.calls.filter(
      (call: any[]) => call[1]?.action === "reviewer_hire_requested",
    );
    expect(hireCalls).toHaveLength(1);
    expect(hireCalls[0]![1]).toMatchObject({
      action: "reviewer_hire_requested",
      details: { reason: "neutrality_conflict", approvalId: "approval-1" },
    });
  });

  it("creates the reviewer through agentService.create as pending_approval with a real adapter and heartbeat", async () => {
    const db = makeDb({ activeReviewerSeq: [[]], depthSeq: [], inserts: [] });
    mockAgentService.create.mockResolvedValue({ id: "agent-real-1" });
    const svc = cosReviewerAutoHire(db, {
      provisionReviewer: vi.fn().mockResolvedValue(undefined),
    });

    const r2 = await svc.evaluateAndHireIfNeeded(C, "neutrality_conflict");
    expect(r2.hired).toBe(true);
    expect(mockAgentService.create).toHaveBeenCalledTimes(1);
    const created = mockAgentService.create.mock.calls[0]![1] as Record<string, any>;
    expect(created.status).toBe("pending_approval");
    // A real adapter, not the old unrunnable "process" stub.
    expect(created.adapterType).toBe("claude-local");
    expect(created.role).toBe("reviewer");
    expect(created.runtimeConfig.heartbeat).toMatchObject({
      enabled: true,
      intervalSec: 1800,
      requireWork: false,
    });
    expect(created.metadata).toMatchObject({
      autoHired: true,
      autoHireReason: "neutrality_conflict",
    });
  });
});

describe("cosReviewerAutoHire — provisioning", () => {
  it("materializes the reviewer bundle and persists adapterConfig; the key is deferred to approval", async () => {
    const db = makeDb({
      activeReviewerSeq: [[]],
      depthSeq: [],
      inserts: [],
    });
    mockAgentService.create.mockResolvedValue({ id: "agent-prov-1" });
    mockAgentService.getById.mockResolvedValue({
      id: "agent-prov-1",
      companyId: C,
      adapterConfig: {},
    });
    // No provisionReviewer dep — exercise the real provisioning path.
    const svc = cosReviewerAutoHire(db, {});

    const result = await svc.evaluateAndHireIfNeeded(C, "neutrality_conflict");
    expect(result.hired).toBe(true);

    expect(mockLoadBundle).toHaveBeenCalledWith("reviewer");
    expect(mockInstructions.materializeManagedBundle).toHaveBeenCalledTimes(1);
    expect(mockAgentService.update).toHaveBeenCalledWith(
      "agent-prov-1",
      expect.objectContaining({
        adapterConfig: expect.objectContaining({
          instructionsBundle: expect.objectContaining({ mode: "managed" }),
        }),
      }),
    );
    // No API key anywhere in this flow: the reviewer authenticates with the
    // run-scoped local JWT the heartbeat injects at run time, so neither the
    // provisioning step nor the approval payload carries a key request.
    expect(mockAgentService.createApiKey).not.toHaveBeenCalled();
    const approvalArg = mockApprovalService.create.mock.calls[0]![1] as Record<string, any>;
    expect(approvalArg.payload).not.toHaveProperty("autoProvisionDefaultKey");
  });
});

describe("cosReviewerAutoHire — kill switch", () => {
  it("MAX_CONCURRENT_HIRES=0 disables the feature outright", async () => {
    process.env.AGENTDASH_REVIEWER_MAX_CONCURRENT_HIRES = "0";
    const inserts: DbScript["inserts"] = [];
    const db = makeDb({
      activeReviewerSeq: [[]],
      depthSeq: [{ value: 1000 }],
      inserts,
    });
    const createAgent = vi.fn();
    const svc = cosReviewerAutoHire(db, { createAgent });

    const result = await svc.evaluateAndHireIfNeeded(C, "neutrality_conflict");
    expect(result.hired).toBe(false);
    expect(result.reason).toBe("disabled");
    expect(createAgent).not.toHaveBeenCalled();
    expect(mockApprovalService.create).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
  });
});

describe("cosReviewerAutoHire — queue_depth threshold", () => {
  it("skips hire when depth < threshold (default threshold=5, activeCount=0 → max(0,1)*5 = 5)", async () => {
    const inserts: DbScript["inserts"] = [];
    const db = makeDb({
      activeReviewerSeq: [[]],
      depthSeq: [{ value: 4 }],
      inserts,
    });
    const svc = cosReviewerAutoHire(db, { createAgent: vi.fn() });

    const result = await svc.evaluateAndHireIfNeeded(C, "queue_depth");
    expect(result.hired).toBe(false);
    expect(result.reason).toBe("below_threshold");
    expect(inserts).toHaveLength(0);
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("hires when depth >= threshold", async () => {
    const inserts: DbScript["inserts"] = [];
    const db = makeDb({
      activeReviewerSeq: [[]],
      depthSeq: [{ value: 10 }],
      inserts,
    });
    const svc = cosReviewerAutoHire(db, {
      createAgent: vi.fn().mockResolvedValue({ id: "agent-new-2" }),
      provisionReviewer: vi.fn().mockResolvedValue(undefined),
    });

    const result = await svc.evaluateAndHireIfNeeded(C, "queue_depth");
    expect(result.hired).toBe(true);
    expect(result.reason).toBe("approval_pending");
    expect(inserts).toHaveLength(1);
  });
});

describe("cosReviewerAutoHire — slot vs capacity counting", () => {
  it("pending_approval reviewers occupy hire slots but not review capacity", async () => {
    // One pending reviewer: slotCount=1 (< cap 3) but activeCount=0, so the
    // depth threshold stays at 5 — the pending reviewer is not reviewing.
    const inserts: DbScript["inserts"] = [];
    const db = makeDb({
      activeReviewerSeq: [[slotRow("a1", "r1", "pending_approval")]],
      depthSeq: [{ value: 5 }],
      inserts,
    });
    const svc = cosReviewerAutoHire(db, {
      createAgent: vi.fn().mockResolvedValue({ id: "agent-new-3" }),
      provisionReviewer: vi.fn().mockResolvedValue(undefined),
    });

    const result = await svc.evaluateAndHireIfNeeded(C, "queue_depth");
    expect(result.hired).toBe(true);
    expect(result.reason).toBe("approval_pending");
    expect(inserts).toHaveLength(1);
  });

  it("counts only runnable reviewers toward capacity (pending reviewer does not raise the threshold)", async () => {
    // idle + pending_approval: activeCount=1 → threshold 5, depth 4 < 5 → skip.
    // If pending_approval counted as capacity, threshold would be 10 and this
    // assertion would be indistinguishable — the 5-depth hire case above and
    // this below-threshold case together pin the runnable filter.
    const inserts: DbScript["inserts"] = [];
    const db = makeDb({
      activeReviewerSeq: [[
        slotRow("a1", "r1", "idle"),
        slotRow("a2", "r2", "pending_approval"),
      ]],
      depthSeq: [{ value: 4 }],
      inserts,
    });
    const svc = cosReviewerAutoHire(db, { createAgent: vi.fn() });

    const result = await svc.evaluateAndHireIfNeeded(C, "queue_depth");
    expect(result.hired).toBe(false);
    expect(result.reason).toBe("below_threshold");
    expect(result.activeCount).toBe(1);
  });

  it("pending_approval reviewers still count toward the hire cap", async () => {
    const inserts: DbScript["inserts"] = [];
    const db = makeDb({
      activeReviewerSeq: [[
        slotRow("a1", "r1", "pending_approval"),
        slotRow("a2", "r2", "pending_approval"),
        slotRow("a3", "r3", "pending_approval"),
      ]],
      depthSeq: [{ value: 1000 }],
      inserts,
    });
    const svc = cosReviewerAutoHire(db, { createAgent: vi.fn() });

    const result = await svc.evaluateAndHireIfNeeded(C, "neutrality_conflict");
    expect(result.hired).toBe(false);
    expect(result.reason).toBe("cap_reached");
    expect(mockApprovalService.create).not.toHaveBeenCalled();
  });

  it("activeReviewers returns only runnable-status assignments", async () => {
    const db = makeDb({
      activeReviewerSeq: [[
        slotRow("a1", "r1", "idle"),
        slotRow("a2", "r2", "running"),
      ]],
      depthSeq: [],
      inserts: [],
    });
    const svc = cosReviewerAutoHire(db, {});
    const rows = await svc.activeReviewers(C);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toEqual(["a1", "a2"]);
  });
});

describe("cosReviewerAutoHire — MAX_CONCURRENT_HIRES cap", () => {
  it("returns cap_reached when slotCount >= cap (default 3)", async () => {
    const activeRows = [
      slotRow("a1", "r1", "idle"),
      slotRow("a2", "r2", "running"),
      slotRow("a3", "r3", "idle"),
    ];
    const inserts: DbScript["inserts"] = [];
    const db = makeDb({
      activeReviewerSeq: [activeRows],
      depthSeq: [{ value: 1000 }],
      inserts,
    });
    const svc = cosReviewerAutoHire(db, { createAgent: vi.fn() });
    const result = await svc.evaluateAndHireIfNeeded(C, "neutrality_conflict");
    expect(result.hired).toBe(false);
    expect(result.reason).toBe("cap_reached");
    expect(inserts).toHaveLength(0);
    const throttled = mockLogActivity.mock.calls.filter(
      (c: any[]) => c[1]?.action === "reviewer_hire_throttled",
    );
    expect(throttled).toHaveLength(1);
  });
});

describe("cosReviewerAutoHire — Free tier cap", () => {
  it("does not auto-hire a reviewer after the Free agent slot is used", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_free_caps";
    mockCompanyService.getById.mockResolvedValue({ id: C, planTier: "free" });
    mockAgentService.list.mockResolvedValue([{ id: "cos-1", status: "idle" }]);
    const inserts: DbScript["inserts"] = [];
    const db = makeDb({
      activeReviewerSeq: [[]],
      depthSeq: [{ value: 1000 }],
      inserts,
    });
    const createAgent = vi.fn().mockResolvedValue({ id: "agent-new" });
    const svc = cosReviewerAutoHire(db, { createAgent });

    const result = await svc.evaluateAndHireIfNeeded(C, "queue_depth");

    expect(result.hired).toBe(false);
    expect(result.reason).toBe("cap_reached");
    expect(createAgent).not.toHaveBeenCalled();
    expect(inserts).toHaveLength(0);
    expect(db.execute).toHaveBeenCalled();
  });
});

describe("cosReviewerAutoHire — convergence (advisory)", () => {
  // Note: a true concurrent FOR UPDATE test requires real PG. Here we
  // sequentially simulate two calls; the second observes the first hire's
  // row in the slot set and stops at cap_reached when cap=1.
  it("second sequential call observes first hire and stops at cap=1", async () => {
    process.env.AGENTDASH_REVIEWER_MAX_CONCURRENT_HIRES = "1";
    const inserts: DbScript["inserts"] = [];
    const db = makeDb({
      activeReviewerSeq: [[], [slotRow("a1", "r1", "pending_approval")]],
      depthSeq: [{ value: 1000 }, { value: 1000 }],
      inserts,
    });
    const svc = cosReviewerAutoHire(db, {
      createAgent: vi.fn().mockResolvedValue({ id: "agent-x" }),
      provisionReviewer: vi.fn().mockResolvedValue(undefined),
    });

    const r1 = await svc.evaluateAndHireIfNeeded(C, "neutrality_conflict");
    const r2 = await svc.evaluateAndHireIfNeeded(C, "neutrality_conflict");
    expect(r1.hired).toBe(true);
    expect(r1.reason).toBe("approval_pending");
    expect(r2.hired).toBe(false);
    expect(r2.reason).toBe("cap_reached");
    expect(inserts).toHaveLength(1);
  });

  /*
   * The real concurrency proof lives in
   * `cos-reviewer-auto-hire-embedded.test.ts`: two parallel evaluations on
   * separate connections race at cap=1 and the per-company advisory lock
   * (taken before any count, unconditionally) serializes them so exactly one
   * hire commits. A mock DB cannot observe lock semantics — the sequential
   * case above only pins the cap-check logic.
   */
});
