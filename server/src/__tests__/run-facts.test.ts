import { describe, expect, it } from "vitest";
import {
  buildRunFacts,
  livenessStateToOutcome,
  normalizeWakeReason,
  resolveMeteringStatus,
} from "../services/run-facts.js";

/**
 * OBS-1 (#694): the honesty contract of the per-run record — unmetered runs
 * say so instead of reading as zero, outcomes and wake reasons normalize to
 * the shared enums.
 */
describe("livenessStateToOutcome", () => {
  it("maps liveness states to the four run outcomes", () => {
    expect(livenessStateToOutcome("advanced")).toBe("produced");
    expect(livenessStateToOutcome("completed")).toBe("produced");
    expect(livenessStateToOutcome("blocked")).toBe("blocked");
    expect(livenessStateToOutcome("failed")).toBe("failed");
    expect(livenessStateToOutcome("empty_response")).toBe("no_op");
    expect(livenessStateToOutcome("plan_only")).toBe("no_op");
    expect(livenessStateToOutcome("needs_followup")).toBe("no_op");
  });

  it("falls back to the terminal status when liveness never classified", () => {
    expect(livenessStateToOutcome(null, "failed")).toBe("failed");
    expect(livenessStateToOutcome(null, "timed_out")).toBe("failed");
    expect(livenessStateToOutcome(null, "cancelled")).toBe("failed");
    expect(livenessStateToOutcome(null, "succeeded")).toBeNull();
  });
});

describe("normalizeWakeReason", () => {
  it("prefers the fine-grained context wakeReason over invocation_source", () => {
    expect(
      normalizeWakeReason({
        invocationSource: "automation",
        contextSnapshot: { wakeReason: "issue_comment_mentioned" },
      }),
    ).toBe("mention");
    expect(
      normalizeWakeReason({
        invocationSource: "automation",
        contextSnapshot: { wakeReason: "approval_approved" },
      }),
    ).toBe("approval");
    expect(
      normalizeWakeReason({
        invocationSource: "automation",
        contextSnapshot: { wakeReason: "process_lost_retry" },
      }),
    ).toBe("retry");
    expect(
      normalizeWakeReason({
        invocationSource: "automation",
        contextSnapshot: { wakeReason: "issue_assigned" },
      }),
    ).toBe("assignment");
  });

  it("classifies the scheduler's real timer wake as timer, not automation", () => {
    // tickTimers enqueues exactly this shape: source "timer" plus reason
    // "heartbeat_timer" landed on contextSnapshot.wakeReason. An unmapped
    // reason falls through to "automation", which is how timer spend hid from
    // both the runFacts label and the OBS-2 ceiling gate.
    expect(
      normalizeWakeReason({
        invocationSource: "timer",
        triggerDetail: "system",
        contextSnapshot: {
          wakeReason: "heartbeat_timer",
          source: "scheduler",
          reason: "interval_elapsed",
        },
      }),
    ).toBe("timer");
  });

  it("maps issue-tree gate transitions to the human buckets", () => {
    for (const [contextReason, expected] of [
      ["execution_review_requested", "approval"],
      ["execution_changes_requested", "approval"],
      ["issue_tree_restored", "manual"],
    ] as const) {
      expect(
        normalizeWakeReason({
          invocationSource: "automation",
          contextSnapshot: { wakeReason: contextReason },
        }),
      ).toBe(expected);
    }
  });

  it("reads unrecognized context reasons as automation, not manual", () => {
    expect(
      normalizeWakeReason({
        invocationSource: "automation",
        contextSnapshot: { wakeReason: "some_future_reason" },
      }),
    ).toBe("automation");
  });

  it("falls back to the invocation source", () => {
    expect(normalizeWakeReason({ invocationSource: "timer" })).toBe("timer");
    expect(normalizeWakeReason({ invocationSource: "assignment" })).toBe("assignment");
    expect(normalizeWakeReason({ invocationSource: "automation" })).toBe("automation");
    expect(normalizeWakeReason({ invocationSource: "on_demand" })).toBe("manual");
    expect(normalizeWakeReason({})).toBe("manual");
  });
});

describe("resolveMeteringStatus", () => {
  it("keeps the status the adapter wrapper stamped", () => {
    for (const status of [
      "metered",
      "adapter_reported",
      "unmetered_no_ledger",
      "unmetered_no_session",
      "unmetered_backfill_ambiguous",
    ] as const) {
      expect(resolveMeteringStatus({ adapterMeteringStatus: status })).toBe(status);
    }
  });

  it("calls adapter-reported usage adapter_reported when nothing was stamped", () => {
    expect(
      resolveMeteringStatus({
        normalizedUsage: { inputTokens: 5, cachedInputTokens: 0, outputTokens: 2 },
      }),
    ).toBe("adapter_reported");
  });

  it("marks a run with no usage signal unmetered_no_session", () => {
    expect(resolveMeteringStatus({})).toBe("unmetered_no_session");
    expect(
      resolveMeteringStatus({
        normalizedUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
      }),
    ).toBe("unmetered_no_session");
  });
});

describe("buildRunFacts", () => {
  const base = {
    meteringStatus: "metered" as const,
    servedModel: "glm-5.3-flash",
    servedProvider: "zai",
    configuredModel: "glm-5.3-flash",
    inputTokens: 1000,
    cachedInputTokens: 400,
    outputTokens: 200,
    turns: 3,
    toolCalls: 7,
    startedAt: new Date("2026-09-24T05:00:00Z"),
    finishedAt: new Date("2026-09-24T05:01:30Z"),
    firstOutputAt: new Date("2026-09-24T05:00:04Z"),
    outcome: "produced" as const,
    wakeReason: "timer" as const,
    now: new Date("2026-09-24T05:02:00Z"),
  };

  it("assembles the normalized record", () => {
    const facts = buildRunFacts({
      ...base,
      ledgerSource: "wrapper_script",
      ledgerCertainty: "certain",
    });
    expect(facts).toEqual({
      meteringStatus: "metered",
      ledgerSource: "wrapper_script",
      ledgerCertainty: "certain",
      servedModel: "glm-5.3-flash",
      servedProvider: "zai",
      configuredModel: "glm-5.3-flash",
      inputTokens: 1000,
      cachedInputTokens: 400,
      outputTokens: 200,
      turns: 3,
      toolCalls: 7,
      wallMs: 90_000,
      firstOutputMs: 4_000,
      outcome: "produced",
      wakeReason: "timer",
      recordedAt: "2026-09-24T05:02:00.000Z",
    });
  });

  it("writes null token fields for unmetered runs — unknown is not zero", () => {
    const facts = buildRunFacts({
      ...base,
      meteringStatus: "unmetered_no_ledger",
      inputTokens: 9999,
      outputTokens: 9999,
    });
    expect(facts.inputTokens).toBeNull();
    expect(facts.cachedInputTokens).toBeNull();
    expect(facts.outputTokens).toBeNull();
    // Non-token facts are still recorded.
    expect(facts.turns).toBe(3);
    expect(facts.wallMs).toBe(90_000);
  });

  it("treats unmetered_backfill_ambiguous as unmetered — nulls, not zeros", () => {
    const facts = buildRunFacts({
      ...base,
      meteringStatus: "unmetered_backfill_ambiguous",
      ledgerSource: "wrapper_script",
      ledgerCertainty: "certain",
      inputTokens: 9999,
      outputTokens: 9999,
    });
    expect(facts.inputTokens).toBeNull();
    expect(facts.outputTokens).toBeNull();
    // The ledger WAS resolved — only the per-run share is unknown.
    expect(facts.ledgerSource).toBe("wrapper_script");
    expect(facts.ledgerCertainty).toBe("certain");
  });

  it("keeps token fields for adapter_reported runs", () => {
    const facts = buildRunFacts({ ...base, meteringStatus: "adapter_reported" });
    expect(facts.inputTokens).toBe(1000);
  });

  it("leaves timing null when the inputs are absent or inverted", () => {
    const facts = buildRunFacts({
      ...base,
      startedAt: null,
      finishedAt: null,
      firstOutputAt: null,
    });
    expect(facts.wallMs).toBeNull();
    expect(facts.firstOutputMs).toBeNull();
  });

  it("defaults an unknown wake reason to manual", () => {
    const facts = buildRunFacts({ ...base, wakeReason: "surprise" as never });
    expect(facts.wakeReason).toBe("manual");
  });
});
