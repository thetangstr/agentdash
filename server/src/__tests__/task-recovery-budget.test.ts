import { describe, expect, it } from "vitest";
import {
  evaluateTaskRecoveryBudget,
  formatTaskRecoveryBudgetUsage,
  resolveTaskRecoveryBudgetLimits,
  TASK_RECOVERY_BUDGET_LIMITS,
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

  // AGE-142 DoD c1: the AGE-104 ledger failure, reproduced. The caller hands
  // over every automatic recovery run in the task scope, refused and
  // cancelled ones included, and each one is an attempt.
  it("counts refused/cancelled automatic runs in the same task scope as attempts", () => {
    const decision = evaluateTaskRecoveryBudget([
      run({ resultJson: { num_turns: 1 }, usageJson: { inputTokens: 10, outputTokens: 5 } }),
      run(),
      run(),
    ]);

    expect(decision.usage.automaticRetries).toBe(3);
    expect(decision.exhaustedBy).toContain("attempts");
  });

  it("lets the first automatic retry run and refuses the next one", () => {
    // No automatic retry spent yet: the first retry is allowed, however long
    // the source run was (the source run is not on the ledger at all).
    const first = evaluateTaskRecoveryBudget([]);
    expect(first.usage.automaticRetries).toBe(0);
    expect(first.exhaustedBy).toEqual([]);
    // One automatic retry spent: with the default limit of 1 the next is refused.
    const second = evaluateTaskRecoveryBudget([run()]);
    expect(second.usage.automaticRetries).toBe(1);
    expect(second.exhaustedBy).toContain("attempts");
  });

  it("leaves cached input tokens out of the token total", () => {
    const decision = evaluateTaskRecoveryBudget(
      [run({ usageJson: { inputTokens: 40_000, cachedInputTokens: 700_000, outputTokens: 15_000 } })],
      { ...TASK_RECOVERY_BUDGET_LIMITS, automaticRetries: 5 },
    );
    expect(decision.usage.providerTokens).toBe(55_000);
    expect(decision.exhaustedBy).toEqual([]);
  });

  it("applies per-agent limits when judging and reporting", () => {
    const limits = { ...TASK_RECOVERY_BUDGET_LIMITS, automaticRetries: 3, providerTurns: 40 };
    const decision = evaluateTaskRecoveryBudget(
      [run({ resultJson: { num_turns: 16 } }), run({ resultJson: { num_turns: 16 } })],
      limits,
    );
    expect(decision.exhaustedBy).toEqual([]);
    expect(formatTaskRecoveryBudgetUsage(decision.usage, limits)).toContain("attempts=2/3");
    expect(formatTaskRecoveryBudgetUsage(decision.usage, limits)).toContain("turns=32/40");
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

describe("resolveTaskRecoveryBudgetLimits", () => {
  it("keeps the defaults when the agent configures nothing", () => {
    expect(resolveTaskRecoveryBudgetLimits({ runtimeConfig: {} })).toEqual({
      limits: { ...TASK_RECOVERY_BUDGET_LIMITS },
      invalidOverride: false,
    });
  });

  it("overrides field by field from runtimeConfig.recoveryBudget", () => {
    const { limits, invalidOverride } = resolveTaskRecoveryBudgetLimits({
      runtimeConfig: { recoveryBudget: { automaticRetries: 2, providerTokens: 2_000_000 } },
    });
    expect(invalidOverride).toBe(false);
    expect(limits).toEqual({ ...TASK_RECOVERY_BUDGET_LIMITS, automaticRetries: 2, providerTokens: 2_000_000 });
  });

  it("ignores an invalid override as a whole", () => {
    const { limits, invalidOverride } = resolveTaskRecoveryBudgetLimits({
      runtimeConfig: { recoveryBudget: { automaticRetries: 2, providerTurns: -1 } },
    });
    expect(invalidOverride).toBe(true);
    expect(limits).toEqual({ ...TASK_RECOVERY_BUDGET_LIMITS });
  });

  it("raises the runtime ceiling to the adapter timeout, never lowers it", () => {
    expect(
      resolveTaskRecoveryBudgetLimits({ runtimeConfig: {}, adapterTimeoutMs: 15 * 60 * 1_000 }).limits.runtimeMs,
    ).toBe(15 * 60 * 1_000);
    expect(
      resolveTaskRecoveryBudgetLimits({ runtimeConfig: {}, adapterTimeoutMs: 60 * 1_000 }).limits.runtimeMs,
    ).toBe(TASK_RECOVERY_BUDGET_LIMITS.runtimeMs);
    expect(
      resolveTaskRecoveryBudgetLimits({
        runtimeConfig: { recoveryBudget: { runtimeMs: 60_000 } },
        adapterTimeoutMs: 600_000,
      }).limits.runtimeMs,
    ).toBe(600_000);
  });
});
