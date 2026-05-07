// Phase H4 — verdict↔approval bridge tests + approvals.ts immutability lint.
//
// Inbound loop: an approval transitions to approved/rejected/revision_requested
// → bridge writes a closing verdict + human_decision_recorded activity row.
// Idempotency: calling onApprovalResolved twice doesn't produce a duplicate.
// Lint: server/src/services/approvals.ts must NOT contain a `// AgentDash:`
// edit marker (the inherited approval lifecycle is forbidden territory).
import { describe, expect, it, vi, beforeEach } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const mockLogActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
  setPluginEventBus: vi.fn(),
  publishPluginDomainEvent: vi.fn(),
}));

vi.mock("../services/live-events.js", () => ({
  subscribeGlobalLiveEvents: vi.fn(() => () => undefined),
}));

import { verdictApprovalBridge } from "../services/verdict-approval-bridge.ts";

const C = "11111111-1111-1111-1111-111111111111";
const APPROVAL_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const VERDICT_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ISSUE_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const USER_ID = "user_admin_1";

function makeApproval(status: string, opts: { decidedAt?: Date | null } = {}) {
  return {
    id: APPROVAL_ID,
    companyId: C,
    type: "verdict_escalation",
    status,
    payload: {
      type: "verdict_escalation",
      verdictId: VERDICT_ID,
      issueId: ISSUE_ID,
    },
    decidedByUserId: status === "pending" ? null : USER_ID,
    decidedAt: opts.decidedAt ?? (status === "pending" ? null : new Date()),
    decisionNote: status === "pending" ? null : "looks fine",
  };
}

function makeDb(approvalRows: unknown[][]) {
  const queue = [...approvalRows];
  const select = vi.fn(() => {
    const result = queue.shift() ?? [];
    const chain: any = {};
    chain.from = vi.fn(() => chain);
    chain.where = vi.fn(() => chain);
    chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject);
    return chain;
  });
  return { select } as any;
}

beforeEach(() => {
  mockLogActivity.mockClear();
});

describe("verdictApprovalBridge.onApprovalResolved — outcome mapping", () => {
  it("approved → writes closing verdict with outcome=passed", async () => {
    const db = makeDb([[makeApproval("approved")]]);
    const verdicts = {
      closingVerdictFor: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "v-new" }),
    } as any;
    const bridge = verdictApprovalBridge(db, { verdicts });

    await bridge.onApprovalResolved(APPROVAL_ID);

    expect(verdicts.create).toHaveBeenCalledTimes(1);
    expect(verdicts.create.mock.calls[0]![0]).toMatchObject({
      entityType: "issue",
      issueId: ISSUE_ID,
      reviewerUserId: USER_ID,
      outcome: "passed",
    });
    const decisionLogs = mockLogActivity.mock.calls.filter(
      (c: any[]) => c[1]?.action === "human_decision_recorded",
    );
    expect(decisionLogs).toHaveLength(1);
    expect(decisionLogs[0]![1]).toMatchObject({
      actorType: "user",
      actorId: USER_ID,
      details: { approvalId: APPROVAL_ID, outcome: "passed" },
    });
  });

  it("rejected → outcome=failed", async () => {
    const db = makeDb([[makeApproval("rejected")]]);
    const verdicts = {
      closingVerdictFor: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "v-2" }),
    } as any;
    const bridge = verdictApprovalBridge(db, { verdicts });
    await bridge.onApprovalResolved(APPROVAL_ID);
    expect(verdicts.create.mock.calls[0]![0].outcome).toBe("failed");
  });

  it("revision_requested → outcome=revision_requested", async () => {
    const db = makeDb([[makeApproval("revision_requested")]]);
    const verdicts = {
      closingVerdictFor: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "v-3" }),
    } as any;
    const bridge = verdictApprovalBridge(db, { verdicts });
    await bridge.onApprovalResolved(APPROVAL_ID);
    expect(verdicts.create.mock.calls[0]![0].outcome).toBe("revision_requested");
  });
});

describe("verdictApprovalBridge — idempotency", () => {
  it("does NOT write a duplicate closing verdict if one already exists", async () => {
    const db = makeDb([[makeApproval("approved")]]);
    const verdicts = {
      // already-closed: a closing verdict was previously written.
      closingVerdictFor: vi.fn().mockResolvedValue({ id: "prior-closing" }),
      create: vi.fn(),
    } as any;
    const bridge = verdictApprovalBridge(db, { verdicts });

    await bridge.onApprovalResolved(APPROVAL_ID);

    expect(verdicts.create).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("ignores approvals that are still pending", async () => {
    const db = makeDb([[makeApproval("pending")]]);
    const verdicts = {
      closingVerdictFor: vi.fn(),
      create: vi.fn(),
    } as any;
    const bridge = verdictApprovalBridge(db, { verdicts });
    await bridge.onApprovalResolved(APPROVAL_ID);
    expect(verdicts.create).not.toHaveBeenCalled();
  });

  it("ignores approvals whose payload.type is not 'verdict_escalation'", async () => {
    const approval = { ...makeApproval("approved"), payload: { type: "hire_agent" } };
    const db = makeDb([[approval]]);
    const verdicts = {
      closingVerdictFor: vi.fn(),
      create: vi.fn(),
    } as any;
    const bridge = verdictApprovalBridge(db, { verdicts });
    await bridge.onApprovalResolved(APPROVAL_ID);
    expect(verdicts.create).not.toHaveBeenCalled();
  });
});

describe("approvals.ts immutability — Phase H4 lint guard", () => {
  // Forbidden-edit guard per Plan §3 Phase C4: bridge must NOT modify
  // server/src/services/approvals.ts. We assert two things:
  //  (1) the source file does NOT carry a `// AgentDash: goals-eval-hitl`
  //      block-marker comment (which would indicate an edit landed there);
  //  (2) the file's diff against `main` (when run inside a working git tree)
  //      contains no goals-eval-hitl insertions. The diff check is best-effort:
  //      if `main` cannot be resolved (e.g. shallow CI checkout), we skip it
  //      gracefully — the static grep is the load-bearing assertion.
  const APPROVALS_PATH = resolve(__dirname, "../services/approvals.ts");

  it("contains no `// AgentDash: goals-eval-hitl` marker", () => {
    const body = readFileSync(APPROVALS_PATH, "utf8");
    expect(body.includes("AgentDash: goals-eval-hitl")).toBe(false);
  });

  it("contains no `verdict_escalation` branch (would imply special-cased lifecycle)", () => {
    const body = readFileSync(APPROVALS_PATH, "utf8");
    expect(body.includes("verdict_escalation")).toBe(false);
  });

  it("git diff against main shows no goals-eval-hitl additions in approvals.ts (best-effort)", () => {
    let diff = "";
    try {
      // Resolve main reference; works in normal worktrees, may fail on shallow CI.
      diff = execSync(
        `git diff main -- server/src/services/approvals.ts`,
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
    } catch {
      // Skip if main isn't fetched. Static grep above is the durable check.
      return;
    }
    // If the file was touched at all, fail loudly.
    expect(diff.includes("goals-eval-hitl")).toBe(false);
    expect(diff.includes("verdict_escalation")).toBe(false);
  });
});
