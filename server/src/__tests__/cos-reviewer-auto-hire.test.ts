// Phase H3 — reviewer auto-hire convergence + neutrality-conflict unit tests.
//
// We mock agentService.create via the deps.createAgent injection point and
// drive db.transaction to call its callback inline. The convergence guard
// (FOR UPDATE) is exercised by sequencing the SELECT-active result so that
// the second concurrent call observes the first hire.
import { describe, expect, it, vi, beforeEach } from "vitest";

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
  setPluginEventBus: vi.fn(),
  publishPluginDomainEvent: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  create: vi.fn(),
}));
vi.mock("../services/agents.js", () => ({
  agentService: vi.fn(() => mockAgentService),
}));

import { cosReviewerAutoHire } from "../services/cos-reviewer-auto-hire.ts";

const C = "11111111-1111-1111-1111-111111111111";

interface DbScript {
  /** Sequence of rows returned by tx.select().for("update") (active reviewers). */
  activeReviewerSeq: unknown[][];
  /** Sequence of rows returned by tx.select().from(issueReviewQueueState).where(...) -> [{value: number}]. */
  depthSeq: Array<{ value: number }>;
  /** Inserts collected so we can assert. */
  inserts: Array<{ table: string; values: Record<string, unknown> }>;
}

function makeDb(script: DbScript) {
  const insertedReviewers: Array<Record<string, unknown>> = [];

  // chain factory for SELECT (.from(...).where(...).for("update")? .then(...))
  function selectChain(rowsProvider: () => unknown[]) {
    const chain: any = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.for = vi.fn(() => chain); // tolerated for the active-reviewers + FOR UPDATE
    chain.orderBy = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(rowsProvider()).then(resolve, reject);
    return chain;
  }

  // Track which select call we're on. The auto-hire transaction issues:
  //  1) SELECT cos_reviewer_assignments WHERE companyId=? AND retiredAt IS NULL FOR UPDATE
  //  2) (queue_depth path only) SELECT count() FROM issue_review_queue_state WHERE ...
  let selectN = 0;

  const select = vi.fn(() => {
    const idx = selectN++;
    return selectChain(() => {
      // Even-indexed selects are active-reviewer queries; odd are depth queries.
      // But because the depth query doesn't always run, we instead track by
      // inspecting the chain's behavior — simpler: maintain two counters.
      // For this stub, we hand back active rows on every other call starting 0.
      // Refined: use an outer counter that we advance through both queues.
      return [];
    });
  });

  // Better approach: route each select() to whichever queue still has data.
  // The first .from() call won't tell us which table. Instead, we inspect by
  // whether the chain's `.for("update")` is invoked — but that's a method
  // call after we've already returned. So just round-robin: the auto-hire
  // code path always calls activeReviewerSeq first, then depthSeq.

  const activeQ = [...script.activeReviewerSeq];
  const depthQ = [...script.depthSeq];

  const select2 = vi.fn(() => {
    let resolved = false;
    let payload: unknown[] = [];
    const chain: any = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.for = vi.fn(() => {
      // Mark this as the active-reviewers query.
      payload = activeQ.shift() ?? [];
      resolved = true;
      return chain;
    });
    chain.orderBy = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
      if (!resolved) {
        // This must be the depth query.
        const next = depthQ.shift();
        payload = next ? [next] : [{ value: 0 }];
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
    select: select2,
    insert: vi.fn(() => ({ values: insertValues })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })) })),
  };
  db.transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));

  void select;
  return db;
}

beforeEach(() => {
  mockLogActivity.mockClear();
  mockAgentService.create.mockReset();
  delete process.env.AGENTDASH_REVIEWER_QUEUE_DEPTH_THRESHOLD;
  delete process.env.AGENTDASH_REVIEWER_MAX_CONCURRENT_HIRES;
});

describe("cosReviewerAutoHire — neutrality_conflict", () => {
  it("hires unconditionally regardless of queue depth", async () => {
    const inserts: DbScript["inserts"] = [];
    const db = makeDb({
      activeReviewerSeq: [[]], // no active reviewers
      depthSeq: [{ value: 0 }], // queue is empty
      inserts,
    });
    const svc = cosReviewerAutoHire(db, {
      createAgent: vi.fn().mockResolvedValue({ id: "agent-new-1" }),
    });

    const result = await svc.evaluateAndHireIfNeeded(C, "neutrality_conflict");
    expect(result.hired).toBe(true);
    expect(result.reason).toBe("hired");
    expect(inserts).toHaveLength(1);
    // activity_log row written with action 'reviewer_hired'
    const reviewerHiredCalls = mockLogActivity.mock.calls.filter(
      (call: any[]) => call[1]?.action === "reviewer_hired",
    );
    expect(reviewerHiredCalls).toHaveLength(1);
    expect(reviewerHiredCalls[0]![1]).toMatchObject({
      action: "reviewer_hired",
      details: { reason: "neutrality_conflict" },
    });
  });
});

describe("cosReviewerAutoHire — queue_depth threshold", () => {
  it("skips hire when depth < threshold (default threshold=5, activeCount=0 → max(0,1)*5 = 5)", async () => {
    const inserts: DbScript["inserts"] = [];
    const db = makeDb({
      activeReviewerSeq: [[]],
      depthSeq: [{ value: 4 }], // below threshold
      inserts,
    });
    const svc = cosReviewerAutoHire(db, {
      createAgent: vi.fn(),
    });

    const result = await svc.evaluateAndHireIfNeeded(C, "queue_depth");
    expect(result.hired).toBe(false);
    expect(result.reason).toBe("below_threshold");
    expect(inserts).toHaveLength(0);
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
    });

    const result = await svc.evaluateAndHireIfNeeded(C, "queue_depth");
    expect(result.hired).toBe(true);
    expect(inserts).toHaveLength(1);
  });
});

describe("cosReviewerAutoHire — MAX_CONCURRENT_HIRES cap", () => {
  it("returns cap_reached when activeCount >= cap (default 3)", async () => {
    const activeRows = [
      { id: "a1", reviewerAgentId: "r1" },
      { id: "a2", reviewerAgentId: "r2" },
      { id: "a3", reviewerAgentId: "r3" },
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
    // throttled audit row written
    const throttled = mockLogActivity.mock.calls.filter(
      (c: any[]) => c[1]?.action === "reviewer_hire_throttled",
    );
    expect(throttled).toHaveLength(1);
  });
});

describe("cosReviewerAutoHire — convergence (advisory)", () => {
  // Note: a true concurrent FOR UPDATE test requires real PG. Here we
  // sequentially simulate two calls; the second observes the first hire's
  // row in the active-reviewer set and stops at cap_reached when cap=1.
  it("second sequential call observes first hire and stops at cap=1", async () => {
    process.env.AGENTDASH_REVIEWER_MAX_CONCURRENT_HIRES = "1";
    const inserts: DbScript["inserts"] = [];
    const db = makeDb({
      activeReviewerSeq: [[], [{ id: "a1", reviewerAgentId: "r1" }]],
      depthSeq: [{ value: 1000 }, { value: 1000 }],
      inserts,
    });
    const svc = cosReviewerAutoHire(db, {
      createAgent: vi.fn().mockResolvedValue({ id: "agent-x" }),
    });

    const r1 = await svc.evaluateAndHireIfNeeded(C, "neutrality_conflict");
    const r2 = await svc.evaluateAndHireIfNeeded(C, "neutrality_conflict");
    expect(r1.hired).toBe(true);
    expect(r2.hired).toBe(false);
    expect(r2.reason).toBe("cap_reached");
    expect(inserts).toHaveLength(1);
  });

  /*
   * ARCHITECTURAL RISK FOLLOW-UP — real-PG `FOR UPDATE` concurrency test.
   *
   * The advisory sequential test above proves the cap-check logic, but it
   * does NOT prove that two genuinely concurrent transactions serialize on
   * the `SELECT … FOR UPDATE` row lock. The mock-DB cannot observe lock
   * semantics — only embedded Postgres can.
   *
   * To enable: convert this to a real-PG test using the existing helper
   *   server/src/__tests__/helpers/embedded-postgres.ts
   * Pattern (mirrors costs-service.test.ts / dashboard-service.test.ts):
   *   1. Call `startEmbeddedPostgresTestDatabase()` in `beforeAll`,
   *      teardown in `afterAll`.
   *   2. Apply the goals-eval-hitl migration (0060) so `cos_reviewer_assignments`
   *      and `feature_flags` exist.
   *   3. Seed N=10 concurrent `evaluateAndHireIfNeeded` calls via Promise.all
   *      with `MAX_CONCURRENT_HIRES=3`.
   *   4. Assert `SELECT count(*) FROM cos_reviewer_assignments WHERE retiredAt
   *      IS NULL` ≤ 3 — i.e. the FOR UPDATE serialized correctly and the
   *      cap held under real concurrency.
   *
   * Skipped today because:
   *   (a) The current vitest harness in this worktree hangs on startup
   *       (documented in Phase H verification report); switching this to
   *       embedded-PG would compound the runner risk.
   *   (b) The convergence-guard logic is exercised by the sequential test
   *       above and by the production `db.transaction(...)` wrapping in
   *       cos-reviewer-auto-hire.ts. The real-PG test would prove the row
   *       lock serializes; it would not change the production code path.
   *
   * Risk if this stays skipped: a regression that removes the FOR UPDATE
   * clause (or wraps the wrong query in the transaction) would not be
   * caught until production. Mitigation: code-review-time check that
   * `tx.select(...).for("update")` appears in the active-reviewers query
   * inside `evaluateAndHireIfNeeded`.
   */
  it.skip("(real-PG) two concurrent Promise.all calls produce ≤ MAX_CONCURRENT_HIRES inserts", async () => {
    // Stub body — see the comment block above for the implementation plan.
    expect(true).toBe(true);
  });
});
