import { describe, expect, it } from "vitest";
import {
  evaluateTaskRecoveryBudget,
  type TaskRecoveryBudgetRun,
} from "../services/task-recovery-budget.ts";

function run(overrides: Partial<TaskRecoveryBudgetRun> = {}): TaskRecoveryBudgetRun {
  return {
    startedAt: "2026-03-19T00:00:00.000Z",
    finishedAt: "2026-03-19T00:00:01.000Z",
    usageJson: null,
    resultJson: null,
    ...overrides,
  };
}

describe("task recovery budget", () => {
  it("counts persisted wall-clock runtime even when provider telemetry is absent", () => {
    const decision = evaluateTaskRecoveryBudget([
      {
        startedAt: "2026-08-26T12:00:00.000Z",
        finishedAt: "2026-08-26T12:05:00.000Z",
        usageJson: null,
        resultJson: null,
      },
    ]);

    expect(decision.usage.runtimeMs).toBe(300_000);
    expect(decision.exhaustedBy).toContain("time");
  });

  // AGE-142 DoD c1: the AGE-104 ledger failure, reproduced. One chained
  // ancestor (the only run the old retryOfRunId walk could see) plus two
  // unlinked refused/cancelled dispatches made three real attempts, while the
  // ledger read attempts=0/1. Scope-based counting sees all three.
  it("counts unlinked refused/cancelled runs in the same task scope as attempts", () => {
    const decision = evaluateTaskRecoveryBudget([
      run({ resultJson: { num_turns: 1 }, usageJson: { inputTokens: 10, outputTokens: 5 } }),
      run(),
      run(),
    ]);

    expect(decision.usage.automaticRetries).toBe(3);
    expect(decision.exhaustedBy).toContain("attempts");
  });

  it("refuses the next dispatch after the limit is spent, but the retry the source run bought still runs", () => {
    // One failed source run = the first attempt. The automatic retry it buys
    // is the last allowed dispatch, so it must not be labelled exhausted...
    const first = evaluateTaskRecoveryBudget([run()]);
    expect(first.usage.automaticRetries).toBe(1);
    expect(first.exhaustedBy).not.toContain("attempts");
    // ...but after that retry fails too, the budget is spent.
    const second = evaluateTaskRecoveryBudget([run(), run()]);
    expect(second.usage.automaticRetries).toBe(2);
    expect(second.exhaustedBy).toContain("attempts");
  });

  it("exhausts attempts at the 50-run scan cap, matching the old chain-walk ceiling", () => {
    const decision = evaluateTaskRecoveryBudget(
      Array.from({ length: 50 }, () => run()),
    );
    expect(decision.usage.automaticRetries).toBe(50);
    expect(decision.exhaustedBy).toContain("attempts");
  });

  it("an empty task scope is never exhausted", () => {
    const decision = evaluateTaskRecoveryBudget([]);
    expect(decision.usage.automaticRetries).toBe(0);
    expect(decision.exhaustedBy).toEqual([]);
  });
});
