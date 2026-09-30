import { describe, expect, it } from "vitest";
import { createAgentSchema, preserveIssueRecoveryBudget, readIssueRecoveryBudget, updateAgentSchema } from "./index.js";

describe("runtimeConfig.recoveryBudget validation", () => {
  it("accepts partial per-agent overrides", () => {
    const parsed = updateAgentSchema.parse({
      runtimeConfig: { recoveryBudget: { automaticRetries: 2, runtimeMs: 900_000 } },
    }) as { runtimeConfig?: { recoveryBudget?: unknown } };
    expect(parsed.runtimeConfig?.recoveryBudget).toEqual({ automaticRetries: 2, runtimeMs: 900_000 });
  });

  it("rejects values above the sanity ceilings, non-positive limits, fractional counts and unknown keys", () => {
    for (const recoveryBudget of [
      { automaticRetries: 11 },
      { providerTurns: 501 },
      { providerTokens: 50_000_001 },
      { providerCostUsd: 100.01 },
      { runtimeMs: 24 * 60 * 60 * 1_000 + 1 },
      { providerTurns: 0 },
      { automaticRetries: 1.5 },
      { providerCostUsd: -1 },
      { retries: 3 },
    ]) {
      expect(() =>
        createAgentSchema.parse({
          name: "Budgeted",
          adapterType: "codex_local",
          runtimeConfig: { recoveryBudget },
        }),
      ).toThrow();
    }
  });
});

describe("readIssueRecoveryBudget", () => {
  it("reads the exhausted marker the heartbeat writes", () => {
    expect(
      readIssueRecoveryBudget({
        status: "pending",
        recoveryBudget: {
          status: "exhausted",
          exhaustedBy: ["attempts", 7],
          usage: { automaticRetries: 1, providerTurns: 20, providerTokens: 72_000, providerCostUsd: 0, runtimeMs: 480_000 },
          exhaustedAt: "2026-01-15T10:00:00.000Z",
          sourceRunId: "run-1",
        },
      }),
    ).toEqual({
      status: "exhausted",
      exhaustedBy: ["attempts"],
      usage: { automaticRetries: 1, providerTurns: 20, providerTokens: 72_000, providerCostUsd: 0, runtimeMs: 480_000 },
      limits: null,
      exhaustedAt: "2026-01-15T10:00:00.000Z",
      sourceRunId: "run-1",
      refusedRunId: null,
    });
  });

  it("is null without an exhausted marker", () => {
    expect(readIssueRecoveryBudget(null)).toBeNull();
    expect(readIssueRecoveryBudget({})).toBeNull();
    expect(readIssueRecoveryBudget({ recoveryBudget: { status: "cleared" } })).toBeNull();
  });
});

describe("preserveIssueRecoveryBudget", () => {
  const recoveryBudget = { status: "exhausted", exhaustedBy: ["attempts"] };

  it("carries the marker onto a nulled or rebuilt state", () => {
    expect(preserveIssueRecoveryBudget({ status: "pending", recoveryBudget }, null)).toEqual({ recoveryBudget });
    expect(preserveIssueRecoveryBudget({ recoveryBudget }, { status: "completed" })).toEqual({
      status: "completed",
      recoveryBudget,
    });
  });

  it("returns the next state unchanged without a marker", () => {
    expect(preserveIssueRecoveryBudget(null, null)).toBeNull();
    expect(preserveIssueRecoveryBudget({ status: "pending" }, null)).toBeNull();
    const next = { status: "completed" };
    expect(preserveIssueRecoveryBudget({}, next)).toBe(next);
  });
});
