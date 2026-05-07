// Phase H1 — verdict service neutrality + shape unit tests.
//
// Pattern: mock-DB style (matches approvals-service.test.ts, costs-service.test.ts).
// Embedded postgres is not used here because Phase H is meant to land without
// DB orchestration overhead and other tests in this directory follow the
// mock-DB pattern. CHECK-constraint enforcement is exercised via a simulated
// postgres error path on insert.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

import { verdictsService } from "../services/verdicts.ts";

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
  // Other named exports re-stubbed for safety.
  setPluginEventBus: vi.fn(),
  publishPluginDomainEvent: vi.fn(),
}));

interface IssueFixture {
  id: string;
  companyId: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}
interface ProjectFixture {
  id: string;
  companyId: string;
  leadAgentId: string | null;
}
interface GoalFixture {
  id: string;
  companyId: string;
  ownerAgentId: string | null;
}

interface DbStubOptions {
  issues?: IssueFixture[];
  projects?: ProjectFixture[];
  goals?: GoalFixture[];
  insertImpl?: (values: Record<string, unknown>) => Record<string, unknown> | Error;
  /** Closing-verdict rows to return for coverage()'s second select. */
  closingVerdicts?: Array<{ issueId: string }>;
  /** In-flight issue rows to return for coverage()'s first select. */
  inFlightIssues?: Array<{
    id: string;
    projectId: string | null;
    goalId: string | null;
    definitionOfDone: unknown;
  }>;
}

/**
 * Lightweight stub that mimics the drizzle query chain used by verdictsService.
 * Each `.select()` call pops the next queued result (so we can sequence
 * loadIssue / loadProject / loadGoal / coverage queries).
 */
function makeDb(opts: DbStubOptions = {}) {
  const selectQueue: unknown[][] = [];

  const inserted: Array<Record<string, unknown>> = [];
  const insertReturning = vi.fn(async () => {
    const last = inserted[inserted.length - 1] ?? {};
    return [{ id: randomUUID(), createdAt: new Date(), ...last }];
  });
  const insertValues = vi.fn((values: Record<string, unknown>) => {
    if (opts.insertImpl) {
      const result = opts.insertImpl(values);
      if (result instanceof Error) {
        return {
          returning: vi.fn(async () => {
            throw result;
          }),
        };
      }
      inserted.push({ ...values, ...result });
    } else {
      inserted.push({ ...values });
    }
    return { returning: insertReturning };
  });

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

  const db = {
    select,
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => [{ id: "updated" }]),
        })),
      })),
    })),
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };

  function queueSelect(rows: unknown[]) {
    selectQueue.push(rows);
  }

  return { db, queueSelect, inserted, insertReturning };
}

const COMPANY_ID = "11111111-1111-1111-1111-111111111111";
const REVIEWER_AGENT = "22222222-2222-2222-2222-222222222222";
const ASSIGNEE_AGENT = "33333333-3333-3333-3333-333333333333";
const ASSIGNEE_USER = "user_abc";
const ISSUE_ID = "44444444-4444-4444-4444-444444444444";
const PROJECT_ID = "55555555-5555-5555-5555-555555555555";
const GOAL_ID = "66666666-6666-6666-6666-666666666666";

beforeEach(() => {
  mockLogActivity.mockClear();
});

describe("verdictsService.create — neutral-validator on issue", () => {
  it("rejects when reviewerAgentId === issues.assigneeAgentId", async () => {
    const { db, queueSelect } = makeDb();
    queueSelect([
      { id: ISSUE_ID, companyId: COMPANY_ID, assigneeAgentId: ASSIGNEE_AGENT, assigneeUserId: null },
    ]);

    const svc = verdictsService(db as any);
    await expect(
      svc.create({
        companyId: COMPANY_ID,
        entityType: "issue",
        issueId: ISSUE_ID,
        reviewerAgentId: ASSIGNEE_AGENT, // same as assignee
        outcome: "passed",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects when reviewerUserId === issues.assigneeUserId (text equality)", async () => {
    const { db, queueSelect } = makeDb();
    queueSelect([
      { id: ISSUE_ID, companyId: COMPANY_ID, assigneeAgentId: null, assigneeUserId: ASSIGNEE_USER },
    ]);

    const svc = verdictsService(db as any);
    await expect(
      svc.create({
        companyId: COMPANY_ID,
        entityType: "issue",
        issueId: ISSUE_ID,
        reviewerUserId: ASSIGNEE_USER, // string ≡ string
        outcome: "passed",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("allows insert when reviewer differs from assignee + writes verdict_recorded", async () => {
    const { db, queueSelect } = makeDb();
    queueSelect([
      { id: ISSUE_ID, companyId: COMPANY_ID, assigneeAgentId: ASSIGNEE_AGENT, assigneeUserId: null },
    ]);

    const svc = verdictsService(db as any);
    const verdict = await svc.create({
      companyId: COMPANY_ID,
      entityType: "issue",
      issueId: ISSUE_ID,
      reviewerAgentId: REVIEWER_AGENT, // different
      outcome: "passed",
      justification: "looks good",
    });

    expect(verdict.id).toBeDefined();
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity.mock.calls[0]![1]).toMatchObject({
      action: "verdict_recorded",
      entityType: "issue",
      entityId: ISSUE_ID,
    });
  });
});

describe("verdictsService.create — neutral-validator on project / goal", () => {
  it("rejects when reviewerAgentId === projects.leadAgentId", async () => {
    const { db, queueSelect } = makeDb();
    queueSelect([{ id: PROJECT_ID, companyId: COMPANY_ID, leadAgentId: ASSIGNEE_AGENT }]);

    const svc = verdictsService(db as any);
    await expect(
      svc.create({
        companyId: COMPANY_ID,
        entityType: "project",
        projectId: PROJECT_ID,
        reviewerAgentId: ASSIGNEE_AGENT,
        outcome: "passed",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects when reviewerAgentId === goals.ownerAgentId", async () => {
    const { db, queueSelect } = makeDb();
    queueSelect([{ id: GOAL_ID, companyId: COMPANY_ID, ownerAgentId: ASSIGNEE_AGENT }]);

    const svc = verdictsService(db as any);
    await expect(
      svc.create({
        companyId: COMPANY_ID,
        entityType: "goal",
        goalId: GOAL_ID,
        reviewerAgentId: ASSIGNEE_AGENT,
        outcome: "passed",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("verdictsService.create — DB CHECK-constraint surfacing", () => {
  it("translates a CHECK violation into VERDICT_SHAPE_INVALID (entityType ≠ FK column)", async () => {
    const { db, queueSelect } = makeDb({
      // Simulate Postgres rejecting the row because entityType='goal' was sent
      // with goalId set but the schema CHECK is named verdicts_entity_target_check.
      insertImpl: () =>
        new Error('new row violates check constraint "verdicts_entity_target_check"'),
    });
    queueSelect([{ id: GOAL_ID, companyId: COMPANY_ID, ownerAgentId: null }]);

    const svc = verdictsService(db as any);
    await expect(
      svc.create({
        companyId: COMPANY_ID,
        entityType: "goal",
        goalId: GOAL_ID,
        reviewerAgentId: REVIEWER_AGENT,
        outcome: "passed",
      }),
    ).rejects.toMatchObject({ status: 422, message: "Verdict shape invalid" });
  });
});

describe("verdictsService.coverage — shape", () => {
  it("returns ratio + counts on a small in-memory fixture", async () => {
    const issueA = { id: "ia", projectId: "p1", goalId: "g1", definitionOfDone: { x: 1 } };
    const issueB = { id: "ib", projectId: "p1", goalId: "g1", definitionOfDone: { x: 1 } };
    const issueNoDoD = { id: "ic", projectId: "p1", goalId: "g1", definitionOfDone: null };
    const issueNoGoal = { id: "id", projectId: "p1", goalId: null, definitionOfDone: { x: 1 } };

    const { db, queueSelect } = makeDb();
    queueSelect([issueA, issueB, issueNoDoD, issueNoGoal]); // in-flight issues
    queueSelect([{ issueId: "ia" }]); // closing-verdict ids

    const svc = verdictsService(db as any);
    const result = await svc.coverage(COMPANY_ID);
    expect(result.totalInFlight).toBe(4);
    expect(result.coveredInFlight).toBe(1);
    // ratio = 1/4 not 1/2: coverage uses totalInFlight as denominator
    expect(result.coverageRatio).toBeCloseTo(0.25, 2);
  });

  it("returns 0/0 with ratio=0 when no in-flight issues", async () => {
    const { db, queueSelect } = makeDb();
    queueSelect([]); // empty

    const svc = verdictsService(db as any);
    const result = await svc.coverage(COMPANY_ID);
    expect(result).toMatchObject({ totalInFlight: 0, coveredInFlight: 0, coverageRatio: 0 });
  });

  // Fix #178: escalated_to_human verdicts mean the loop is OPEN (waiting on a
  // human). They must NOT count as covered. The bridge writes a closing
  // verdict (passed/failed) once the human resolves the approval — that
  // closing verdict is what counts toward coverage.
  it("does NOT count escalated_to_human verdicts as covered", async () => {
    const issueEscalatedOnly = {
      id: "ie",
      projectId: "p1",
      goalId: "g1",
      definitionOfDone: { x: 1 },
    };
    const issuePassed = { id: "ip", projectId: "p1", goalId: "g1", definitionOfDone: { x: 1 } };

    const { db, queueSelect } = makeDb();
    queueSelect([issueEscalatedOnly, issuePassed]); // in-flight issues
    // The runtime filter (COVERED_OUTCOMES = passed | failed) is applied in
    // the WHERE clause, so the stub returns ONLY the passed issue's id —
    // the escalated_to_human row would have been filtered out.
    queueSelect([{ issueId: "ip" }]);

    const svc = verdictsService(db as any);
    const result = await svc.coverage(COMPANY_ID);
    expect(result.totalInFlight).toBe(2);
    expect(result.coveredInFlight).toBe(1);
    expect(result.coverageRatio).toBeCloseTo(0.5, 2);
  });
});

// ---------------------------------------------------------------------------
// Fix #179 — verdictsService.create with outcome=escalated_to_human auto-
// creates a verdict_escalation approval and links it via issue_approvals.
// ---------------------------------------------------------------------------

describe("verdictsService.create — auto-creates verdict_escalation approval (Fix #179)", () => {
  it("on outcome=escalated_to_human, calls approvalsService.create + issueApprovalsService.link", async () => {
    const { db, queueSelect } = makeDb();
    // loadIssue lookup: reviewer ≠ assignee so neutrality passes.
    queueSelect([
      { id: ISSUE_ID, companyId: COMPANY_ID, assigneeAgentId: ASSIGNEE_AGENT, assigneeUserId: null },
    ]);

    const APPROVAL_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const approvalsService = {
      create: vi.fn().mockResolvedValue({ id: APPROVAL_ID, status: "pending" }),
    };
    const issueApprovalsService = {
      link: vi.fn().mockResolvedValue({ issueId: ISSUE_ID, approvalId: APPROVAL_ID }),
    };

    const svc = verdictsService(db as any, {
      approvalsService: approvalsService as any,
      issueApprovalsService: issueApprovalsService as any,
    });

    const verdict = await svc.create({
      companyId: COMPANY_ID,
      entityType: "issue",
      issueId: ISSUE_ID,
      reviewerAgentId: REVIEWER_AGENT,
      outcome: "escalated_to_human",
      justification: "taste-critical, needs human eyes",
    });

    expect(verdict.id).toBeDefined();

    // Approval was created with the right type + payload shape.
    expect(approvalsService.create).toHaveBeenCalledTimes(1);
    expect(approvalsService.create.mock.calls[0]![0]).toBe(COMPANY_ID);
    expect(approvalsService.create.mock.calls[0]![1]).toMatchObject({
      type: "verdict_escalation",
      requestedByAgentId: REVIEWER_AGENT,
      status: "pending",
      payload: {
        type: "verdict_escalation",
        issueId: ISSUE_ID,
        justification: "taste-critical, needs human eyes",
      },
    });

    // Issue↔approval link was created.
    expect(issueApprovalsService.link).toHaveBeenCalledTimes(1);
    expect(issueApprovalsService.link).toHaveBeenCalledWith(
      ISSUE_ID,
      APPROVAL_ID,
      expect.objectContaining({ agentId: REVIEWER_AGENT }),
    );

    // Activity log: verdict_recorded + escalated_to_human.
    const escalations = mockLogActivity.mock.calls.filter(
      (c) => c[1]?.action === "escalated_to_human",
    );
    expect(escalations).toHaveLength(1);
    expect(escalations[0]![1]).toMatchObject({
      details: { approvalId: APPROVAL_ID, issueId: ISSUE_ID },
    });
  });

  it("does NOT auto-create approval when deps are not provided (back-compat)", async () => {
    const { db, queueSelect } = makeDb();
    queueSelect([
      { id: ISSUE_ID, companyId: COMPANY_ID, assigneeAgentId: ASSIGNEE_AGENT, assigneeUserId: null },
    ]);

    // No deps passed.
    const svc = verdictsService(db as any);

    const verdict = await svc.create({
      companyId: COMPANY_ID,
      entityType: "issue",
      issueId: ISSUE_ID,
      reviewerAgentId: REVIEWER_AGENT,
      outcome: "escalated_to_human",
      justification: "no deps wired",
    });
    expect(verdict.id).toBeDefined();

    // Only the verdict_recorded activity, no escalated_to_human.
    const escalations = mockLogActivity.mock.calls.filter(
      (c) => c[1]?.action === "escalated_to_human",
    );
    expect(escalations).toHaveLength(0);
  });

  it("does NOT auto-create approval for non-escalated outcomes (passed)", async () => {
    const { db, queueSelect } = makeDb();
    queueSelect([
      { id: ISSUE_ID, companyId: COMPANY_ID, assigneeAgentId: ASSIGNEE_AGENT, assigneeUserId: null },
    ]);

    const approvalsService = { create: vi.fn() };
    const issueApprovalsService = { link: vi.fn() };

    const svc = verdictsService(db as any, {
      approvalsService: approvalsService as any,
      issueApprovalsService: issueApprovalsService as any,
    });

    await svc.create({
      companyId: COMPANY_ID,
      entityType: "issue",
      issueId: ISSUE_ID,
      reviewerAgentId: REVIEWER_AGENT,
      outcome: "passed",
    });

    expect(approvalsService.create).not.toHaveBeenCalled();
    expect(issueApprovalsService.link).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Phase H — DoD setter + metric setter activity-log assertions.
// ---------------------------------------------------------------------------

describe("verdictsService.setProjectDoD", () => {
  const validDoD = {
    summary: "Ship the feature",
    criteria: [{ id: "c1", text: "Tests pass", done: false }],
  };

  it("validates input, updates project, and writes dod_set activity for project entity", async () => {
    const { db, queueSelect } = makeDb();
    queueSelect([{ id: PROJECT_ID, companyId: COMPANY_ID, leadAgentId: null }]);

    const svc = verdictsService(db as any);
    const result = await svc.setProjectDoD(COMPANY_ID, PROJECT_ID, validDoD as any);
    expect(result).toBeDefined();

    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity.mock.calls[0]![1]).toMatchObject({
      action: "dod_set",
      entityType: "project",
      entityId: PROJECT_ID,
    });
    expect(mockLogActivity.mock.calls[0]![1].details).toMatchObject({
      definitionOfDone: validDoD,
    });
  });

  it("rejects invalid DoD shape with code DOD_INVALID and does NOT write activity", async () => {
    const { db } = makeDb();

    const svc = verdictsService(db as any);
    await expect(
      // Missing required summary + criteria.
      svc.setProjectDoD(COMPANY_ID, PROJECT_ID, { summary: "" } as any),
    ).rejects.toMatchObject({
      status: 400,
      code: "DOD_INVALID",
    });
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});

describe("verdictsService.setIssueDoD", () => {
  const validDoD = {
    summary: "Done means tests pass",
    criteria: [{ id: "x1", text: "All assertions green", done: false }],
  };

  it("validates, updates issue, and writes dod_set activity for issue entity", async () => {
    const { db, queueSelect } = makeDb();
    queueSelect([
      { id: ISSUE_ID, companyId: COMPANY_ID, assigneeAgentId: null, assigneeUserId: null },
    ]);

    const svc = verdictsService(db as any);
    const result = await svc.setIssueDoD(COMPANY_ID, ISSUE_ID, validDoD as any);
    expect(result).toBeDefined();

    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity.mock.calls[0]![1]).toMatchObject({
      action: "dod_set",
      entityType: "issue",
      entityId: ISSUE_ID,
    });
  });

  it("rejects invalid DoD with DOD_INVALID", async () => {
    const { db } = makeDb();
    const svc = verdictsService(db as any);
    await expect(
      svc.setIssueDoD(COMPANY_ID, ISSUE_ID, {
        summary: "",
        criteria: [],
      } as any),
    ).rejects.toMatchObject({ status: 400, code: "DOD_INVALID" });
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});

describe("verdictsService.setGoalMetricDefinition", () => {
  const validMetric = {
    target: 100,
    unit: "leads",
    source: "manual",
    baseline: 0,
    currentValue: 12,
  };

  it("validates and writes metric_updated activity_log row for goal entity", async () => {
    const { db, queueSelect } = makeDb();
    queueSelect([{ id: GOAL_ID, companyId: COMPANY_ID, ownerAgentId: null }]);

    const svc = verdictsService(db as any);
    const result = await svc.setGoalMetricDefinition(COMPANY_ID, GOAL_ID, validMetric as any);
    expect(result).toBeDefined();

    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity.mock.calls[0]![1]).toMatchObject({
      action: "metric_updated",
      entityType: "goal",
      entityId: GOAL_ID,
    });
  });

  it("rejects invalid metric definition with METRIC_DEFINITION_INVALID", async () => {
    const { db } = makeDb();
    const svc = verdictsService(db as any);
    await expect(
      svc.setGoalMetricDefinition(COMPANY_ID, GOAL_ID, {
        // Missing required `unit` and `source`.
        target: 10,
      } as any),
    ).rejects.toMatchObject({ status: 400, code: "METRIC_DEFINITION_INVALID" });
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});
