import { describe, expect, it } from "vitest";
import {
  buildAgentPerformanceProjection,
  countCronFiresInWindow,
  type AgentPerformanceProjectionInput,
} from "../services/agent-performance-projection.js";
import { nextCronTickInTimeZone } from "../services/routines.js";

/**
 * AgentDash: APM gate 1 — the performance projection is a pure function of
 * live rows. Unknown is null with a note (never 0), the four acceptance facts
 * stay separate, and owed work is counted from the current routine
 * definitions with the routines scheduler's own timezone semantics.
 */

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const REVIEWER_ID = "22222222-2222-4222-8222-222222222222";
const COMPANY_ID = "33333333-3333-4333-8333-333333333333";
const AS_OF = new Date("2026-10-29T12:00:00.000Z");

/** Count fires the way the scheduler finds them: one `nextCronTickInTimeZone` at a time. */
function schedulerCount(expression: string, timeZone: string, from: Date, to: Date) {
  let after = new Date(Math.ceil(from.getTime() / 60_000) * 60_000 - 60_000);
  let count = 0;
  for (;;) {
    const next = nextCronTickInTimeZone(expression, timeZone, after);
    if (!next || next.getTime() > to.getTime()) return count;
    count += 1;
    after = next;
  }
}

describe("countCronFiresInWindow", () => {
  it("counts a weekday schedule in UTC", () => {
    // 2026-10-01 is a Thursday; October 2026 has 22 weekdays.
    expect(countCronFiresInWindow("0 9 * * 1-5", "UTC", new Date("2026-10-01T00:00:00Z"), new Date("2026-10-31T23:59:00Z"))).toBe(22);
  });

  it("skips the spring-forward minute that never happens on the wall clock", () => {
    const from = new Date("2026-03-07T00:00:00Z");
    const to = new Date("2026-03-10T00:00:00Z");
    // 02:30 local on 7 and 9 March; 8 March jumps from 02:00 to 03:00 in New York.
    expect(countCronFiresInWindow("30 2 * * *", "America/New_York", from, to)).toBe(2);
    expect(countCronFiresInWindow("30 2 * * *", "UTC", from, to)).toBe(3);
  });

  it("fires twice in the repeated fall-back hour", () => {
    const from = new Date("2026-10-31T12:00:00Z");
    const to = new Date("2026-11-02T12:00:00Z");
    // 01:30 EDT and 01:30 EST on 1 November, then 01:30 EST on 2 November.
    expect(countCronFiresInWindow("30 1 * * *", "America/New_York", from, to)).toBe(3);
  });

  it("handles a 30-minute daylight-saving shift", () => {
    // Lord Howe Island: 02:00 +11:00 becomes 01:30 +10:30 on 5 April 2026, so 01:45 happens twice that day.
    expect(countCronFiresInWindow("45 1 * * *", "Australia/Lord_Howe", new Date("2026-04-04T00:00:00Z"), new Date("2026-04-06T00:00:00Z"))).toBe(3);
  });

  it("counts local midnight in a half-hour zone", () => {
    expect(countCronFiresInWindow("0 0 * * *", "Asia/Kolkata", new Date("2026-10-01T00:00:00Z"), new Date("2026-10-08T00:00:00Z"))).toBe(7);
  });

  it("starts at the first whole minute inside the window and ends at the last", () => {
    expect(countCronFiresInWindow("0 9 * * *", "UTC", new Date("2026-10-01T09:00:30Z"), new Date("2026-10-03T09:00:00Z"))).toBe(2);
    expect(countCronFiresInWindow("0 9 * * *", "UTC", new Date("2026-10-03T00:00:00Z"), new Date("2026-10-02T00:00:00Z"))).toBe(0);
  });

  it("throws on an unreadable expression or timezone", () => {
    expect(() => countCronFiresInWindow("not a cron", "UTC", AS_OF, AS_OF)).toThrow();
    expect(() => countCronFiresInWindow("0 9 * * *", "Mars/Olympus", AS_OF, AS_OF)).toThrow();
  });

  const crossChecks: Array<[string, string, string, string]> = [
    ["*/5 * * * *", "America/New_York", "2026-03-07T22:00:00Z", "2026-03-09T02:00:00Z"],
    ["30 1 * * *", "America/New_York", "2026-10-31T00:00:00Z", "2026-11-03T00:00:00Z"],
    ["*/15 * * * *", "Asia/Kathmandu", "2026-10-01T00:07:00Z", "2026-10-02T03:00:00Z"],
    // Lord Howe Island moves its clocks by 30 minutes; 01:45 happens twice on 5 April 2026.
    ["45 1 * * *", "Australia/Lord_Howe", "2026-04-04T00:00:00Z", "2026-04-06T00:00:00Z"],
    ["*/7 * * * *", "Australia/Lord_Howe", "2026-04-04T12:00:00Z", "2026-04-04T18:00:00Z"],
    ["0 9 * * 1", "Europe/London", "2026-03-20T00:00:00Z", "2026-04-07T00:00:00Z"],
  ];
  for (const [expression, timeZone, from, to] of crossChecks) {
    it(`agrees with the routines scheduler: ${expression} in ${timeZone}`, () => {
      const window = [new Date(from), new Date(to)] as const;
      expect(countCronFiresInWindow(expression, timeZone, ...window)).toBe(schedulerCount(expression, timeZone, ...window));
    });
  }

  it("counts a year-long window quickly", () => {
    const started = Date.now();
    // New York's offsets are whole hours, so every UTC hour has a local :00; both ends are inclusive.
    expect(countCronFiresInWindow("0 * * * *", "America/New_York", new Date("2025-10-29T12:00:00Z"), AS_OF)).toBe(365 * 24 + 1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

function baseInput(overrides: Partial<AgentPerformanceProjectionInput> = {}): AgentPerformanceProjectionInput {
  return {
    companyId: COMPANY_ID,
    agentId: AGENT_ID,
    asOf: AS_OF,
    windowDays: 7,
    throughSeq: 42,
    routines: [],
    routineRunCounts: [],
    routineLinkedIssues: [],
    assignedIssueStatusCounts: {},
    verdictCounts: [],
    accountable: [],
    spendCents: 0,
    heartbeatRunCounts: [],
    questions: [],
    openQuestionsToPeople: 0,
    correctionCounts: [],
    refusalCounts: [],
    pendingApprovals: 0,
    projectsWithheld: false,
    ...overrides,
  };
}

const routineCreated = new Date("2026-01-01T00:00:00Z");
function trigger(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    kind: "schedule",
    enabled: true,
    cronExpression: "0 9 * * *",
    timezone: "America/Los_Angeles",
    createdAt: routineCreated,
    ...overrides,
  };
}

describe("buildAgentPerformanceProjection", () => {
  it("states the window, the ledger cut and that nothing was written", () => {
    const projection = buildAgentPerformanceProjection(baseInput());
    expect(projection).toMatchObject({
      kind: "agent_performance_projection",
      version: "agent-projection/0",
      companyId: COMPANY_ID,
      agentId: AGENT_ID,
      generatedAt: AS_OF.toISOString(),
      asOf: AS_OF.toISOString(),
      window: { from: "2026-10-22T12:00:00.000Z", to: AS_OF.toISOString() },
      throughSeq: 42,
      sideEffectFree: true,
      owed: { source: "current_definitions", historyKnown: false, routines: [] },
    });
    expect(projection.withheld).toEqual([
      { section: "paired-harness assessments", reason: "Shown once evidence access rules ship (gate 3)" },
    ]);
    expect(projection.gaps.map((g) => g.code)).toEqual(["ATTRIBUTION_CURRENT_ASSIGNEE"]);
    expect(buildAgentPerformanceProjection(baseInput({ throughSeq: null })).throughSeq).toBeNull();
    // No composite: nothing in the output is a score.
    expect(JSON.stringify(projection)).not.toMatch(/"score"|"composite"/i);
  });

  it("Q1: counts owed fire times per trigger from the current definition, and null with a note otherwise", () => {
    const projection = buildAgentPerformanceProjection(
      baseInput({
        routines: [
          {
            id: "r-active",
            title: "Daily digest",
            status: "active",
            createdAt: routineCreated,
            triggers: [
              trigger("t-daily"),
              // Created three days before asOf: owed nothing before it existed.
              trigger("t-new", { cronExpression: "0 18 * * *", createdAt: new Date("2026-10-26T12:00:00Z") }),
              trigger("t-off", { enabled: false }),
              trigger("t-hook", { kind: "webhook", cronExpression: null, timezone: null }),
              trigger("t-bad", { cronExpression: "99 * * * *" }),
            ],
          },
          { id: "r-paused", title: "Paused one", status: "paused", createdAt: routineCreated, triggers: [trigger("t-paused")] },
          { id: "r-bare", title: "Manual only", status: "active", createdAt: routineCreated, triggers: [] },
        ],
        routineRunCounts: [
          { routineId: "r-active", triggerId: "t-daily", status: "issue_created", n: 4 },
          { routineId: "r-active", triggerId: "t-daily", status: "completed", n: 2 },
          { routineId: "r-active", triggerId: "t-daily", status: "received", n: 1 },
          { routineId: "r-active", triggerId: "t-hook", status: "failed", n: 1 },
          { routineId: "r-active", triggerId: null, status: "skipped", n: 1 },
          { routineId: "r-active", triggerId: "t-deleted", status: "coalesced", n: 2 },
        ],
        routineLinkedIssues: [
          { routineId: "r-active", triggerId: "t-daily", issueId: "i1", issueStatus: "done" },
          { routineId: "r-active", triggerId: "t-daily", issueId: "i2", issueStatus: "in_progress" },
          { routineId: "r-active", triggerId: "t-daily", issueId: "i2", issueStatus: "in_progress" },
          { routineId: "r-active", triggerId: "t-daily", issueId: "i3", issueStatus: "cancelled" },
          { routineId: "r-active", triggerId: null, issueId: "i4", issueStatus: null },
        ],
      }),
    );
    const byTrigger = new Map(projection.owed.routines.map((row) => [`${row.routineId}/${row.triggerId}`, row]));
    // 7-day window ending 12:00Z: 09:00 Los Angeles (16:00Z) on each of 7 days.
    expect(byTrigger.get("r-active/t-daily")).toEqual({
      routineId: "r-active",
      title: "Daily digest",
      triggerId: "t-daily",
      triggerKind: "schedule",
      cronExpression: "0 9 * * *",
      timezone: "America/Los_Angeles",
      enabled: true,
      owedInWindow: 7,
      note: null,
      runs: { total: 7, issueCreated: 4, completed: 2, failed: 0, skipped: 0, coalesced: 0 },
      linkedIssues: { done: 1, open: 1, cancelled: 1 },
    });
    // 18:00 LA = 01:00Z next day: 27, 28 and 29 October (UTC) fall after 26 Oct 12:00Z.
    expect(byTrigger.get("r-active/t-new")).toMatchObject({
      owedInWindow: 3,
      note: "Trigger created inside the window; counted from 2026-10-26T12:00:00.000Z.",
    });
    for (const key of ["r-active/t-off", "r-active/t-hook", "r-active/t-bad", "r-paused/t-paused", "r-bare/null"]) {
      expect(byTrigger.get(key)?.owedInWindow, key).toBeNull();
    }
    expect(byTrigger.get("r-active/t-hook")?.runs).toMatchObject({ total: 1, failed: 1 });
    // Manual runs and runs of a deleted trigger land on one trigger-less row.
    expect(byTrigger.get("r-active/null")).toMatchObject({
      triggerKind: null,
      enabled: false,
      owedInWindow: null,
      runs: { total: 3, skipped: 1, coalesced: 2 },
      linkedIssues: { done: 0, open: 1, cancelled: 0 },
    });
    expect(byTrigger.get("r-bare/null")?.runs.total).toBe(0);
    // Every null owed count says why, on its own row; none of this is a gap.
    expect(byTrigger.get("r-active/t-off")?.note).toMatch(/disabled schedule trigger/);
    expect(byTrigger.get("r-active/t-hook")?.note).toMatch(/webhook trigger, which owes work only when it is called/);
    expect(byTrigger.get("r-active/t-bad")?.note).toMatch(/can't be read/);
    expect(byTrigger.get("r-paused/t-paused")?.note).toMatch(/"Paused one" is paused/);
    expect(byTrigger.get("r-bare/null")?.note).toMatch(/"Manual only" has no trigger/);
    expect(byTrigger.get("r-active/null")?.note).toMatch(/no current trigger/);
    expect(projection.gaps.map((g) => g.code)).toEqual(["ATTRIBUTION_CURRENT_ASSIGNEE"]);
  });

  it("Q1: counts issues currently assigned, by status", () => {
    const projection = buildAgentPerformanceProjection(
      baseInput({ assignedIssueStatusCounts: { backlog: 1, todo: 2, in_progress: 3, in_review: 4, blocked: 5, done: 6, cancelled: 7 } }),
    );
    expect(projection.owed.assigned).toEqual({ open: 3, inProgress: 3, inReview: 4, blocked: 5, done: 6, cancelled: 7 });
  });

  it("Q2/Q3: splits verdicts by outcome and by judge, and keeps the four acceptance facts separate", () => {
    const projection = buildAgentPerformanceProjection(
      baseInput({
        verdictCounts: [
          { outcome: "passed", reviewerAgentId: null, reviewerUserId: "user-real", n: 3 },
          { outcome: "failed", reviewerAgentId: null, reviewerUserId: "user-real", n: 1 },
          { outcome: "passed", reviewerAgentId: REVIEWER_ID, reviewerUserId: null, n: 2 },
          { outcome: "revision_requested", reviewerAgentId: REVIEWER_ID, reviewerUserId: null, n: 1 },
          { outcome: "passed", reviewerAgentId: AGENT_ID, reviewerUserId: null, n: 5 },
          { outcome: "escalated_to_human", reviewerAgentId: AGENT_ID, reviewerUserId: null, n: 1 },
          { outcome: "pending", reviewerAgentId: null, reviewerUserId: "local-board", n: 2 },
        ],
      }),
    );
    expect(projection.quality).toEqual({
      verdicts: { passed: 10, failed: 1, changesRequested: 1, escalated: 1, other: 2 },
      byJudge: { person: 4, independentAgent: 3, nonIndependent: 6 },
    });
    // Self-passes count toward neither automated nor human acceptance.
    expect(projection.acceptance.automated).toMatchObject({ value: 2, of: 3 });
    expect(projection.acceptance.human).toMatchObject({ value: 3, of: 4 });
    expect(projection.acceptance.use).toEqual({ value: null, of: null, note: "No use records yet" });
    expect(projection.acceptance.outcome).toEqual({ value: null, of: null, note: "Goal metric history arrives in gate 3" });
    expect(projection.gaps.find((g) => g.code === "UNATTRIBUTED_JUDGE")?.message).toMatch(/^2 verdict/);
  });

  it("Q3: cites the latest stored evaluator card for led projects and owned goals, else says there is none", () => {
    const card = {
      outcome: {
        O1: { key: "O1", name: "Acceptance satisfied", unit: "share of items", value: 0.75, headline: "3 of 4 items met acceptance", confidenceLabel: "Moderate" },
        O2: { key: "O2", name: "Deadline adherence", unit: "share closed on time", value: null, headline: "no target date", confidenceLabel: "Insufficient" },
        O3: { key: "O3", name: "Downstream risk index", unit: "events per item", value: 0, headline: "no consequences after close" },
      },
    };
    const projection = buildAgentPerformanceProjection(
      baseInput({
        accountable: [
          { kind: "project", id: "p1", title: "Launch", status: "in_progress", card: { version: 3, throughSeq: 40, card } },
          { kind: "goal", id: "g1", title: "Grow", status: "active", card: null },
        ],
      }),
    );
    const [project, goal] = projection.acceptance.accountable;
    expect(project).toMatchObject({ kind: "project", id: "p1", title: "Launch", status: "in_progress", note: "Evaluator card version 3 (ledger through seq 40)" });
    expect(project!.outcome!.acceptance).toEqual({ value: 0.75, of: null, note: "O1 Acceptance satisfied (share of items): 3 of 4 items met acceptance" });
    // A stored null stays null; a stored 0 stays 0.
    expect(project!.outcome!.onTime.value).toBeNull();
    expect(project!.outcome!.onTime.note).toContain("Insufficient");
    expect(project!.outcome!.rework.value).toBe(0);
    expect(project!.outcome!.evidence).toEqual({ value: null, of: null, note: "O5 is not on this card" });
    expect(goal).toEqual({ kind: "goal", id: "g1", title: "Grow", status: "active", outcome: null, note: "No evaluator card" });
  });

  it("Q4: reports spend, runs and people proxies, with human corrections only from people", () => {
    const asked = (minutesAgo: number) => new Date(AS_OF.getTime() - minutesAgo * 60_000);
    const projection = buildAgentPerformanceProjection(
      baseInput({
        spendCents: 1234,
        heartbeatRunCounts: [
          { status: "succeeded", hasIssue: true, n: 5 },
          { status: "succeeded", hasIssue: false, n: 2 },
          { status: "failed", hasIssue: true, n: 1 },
          { status: "timed_out", hasIssue: false, n: 1 },
          { status: "running", hasIssue: true, n: 1 },
        ],
        questions: [
          { status: "answered", createdAt: asked(100), resolvedAt: asked(90), resolvedByUserId: "u1", resolvedByAgentId: null },
          { status: "accepted", createdAt: asked(100), resolvedAt: asked(70), resolvedByUserId: "u1", resolvedByAgentId: null },
          { status: "answered", createdAt: asked(100), resolvedAt: asked(99), resolvedByUserId: null, resolvedByAgentId: REVIEWER_ID },
          { status: "pending", createdAt: asked(10), resolvedAt: null, resolvedByUserId: null, resolvedByAgentId: null },
          { status: "cancelled", createdAt: asked(10), resolvedAt: asked(5), resolvedByUserId: "u1", resolvedByAgentId: null },
        ],
        correctionCounts: [
          { kind: "steward_send_back", sourceActorType: "user", n: 2 },
          { kind: "handoff_returned", sourceActorType: "agent", n: 3 },
          { kind: "harness_evaluation", sourceActorType: "user", n: 9 },
        ],
      }),
    );
    expect(projection.cost).toEqual({
      spendCents: 1234,
      runs: { total: 10, succeeded: 7, failed: 2, withoutIssue: 3 },
      peopleProxies: {
        questionsAsked: 5,
        questionsAnswered: 2,
        medianAnswerWaitMinutes: 20,
        humanCorrections: {
          value: 2,
          of: null,
          note: "Corrections recorded by people; 3 correction(s) from other agents are not counted",
        },
      },
    });
    expect(projection.gaps.find((g) => g.code === "QUESTIONS_ANSWERED_BY_AGENT")?.message).toMatch(/^1 question/);
  });

  it("Q4: no answered question means an unknown median, not zero", () => {
    const projection = buildAgentPerformanceProjection(baseInput());
    expect(projection.cost.peopleProxies).toEqual({
      questionsAsked: 0,
      questionsAnswered: 0,
      medianAnswerWaitMinutes: null,
      humanCorrections: { value: 0, of: null, note: "Corrections recorded by people" },
    });
  });

  it("Q5/Q6: groups refused attempts by code and counts open decisions", () => {
    const projection = buildAgentPerformanceProjection(
      baseInput({
        refusalCounts: [
          { action: "authz.refused", reasonCode: "AGENT_CROSS_COMPANY", n: 2 },
          { action: "authz.refused", reasonCode: null, n: 1 },
          { action: "connector_send.refused", reasonCode: null, n: 1 },
        ],
        pendingApprovals: 2,
        openQuestionsToPeople: 3,
      }),
    );
    expect(projection.bounds).toEqual({
      refusedAttempts: 4,
      byCode: { AGENT_CROSS_COMPANY: 2, UNSPECIFIED: 1, "connector_send.refused": 1 },
    });
    expect(projection.decisions).toEqual({ pendingApprovals: 2, openQuestionsToPeople: 3 });
  });

  it("names withheld restricted-project work without a count", () => {
    const projection = buildAgentPerformanceProjection(baseInput({ projectsWithheld: true }));
    expect(projection.withheld).toEqual([
      { section: "paired-harness assessments", reason: "Shown once evidence access rules ship (gate 3)" },
      {
        section: "work in projects you can't see",
        reason: "Issues, verdicts, runs, spend and questions in restricted projects you can't read are left out of every count",
      },
    ]);
    expect(JSON.stringify(projection.withheld[1])).not.toMatch(/\d/);
  });
});
