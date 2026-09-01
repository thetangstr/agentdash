import { describe, expect, it } from "vitest";
import { evaluateTaskRecoveryBudget } from "../services/task-recovery-budget.ts";

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
});
