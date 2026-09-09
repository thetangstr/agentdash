import { describe, expect, it } from "vitest";
import { summarizeAgentTrouble } from "./agent-trouble";

type Run = { status: string; error: string | null; errorCode?: string | null; finishedAt: string | null };
const run = (o: Partial<Run>): Run =>
  ({ status: "failed", error: null, errorCode: null, finishedAt: "2026-09-08T16:08:07.000Z", ...o }) as Run;

// The exact shape HAL was in, newest first.
const HAL_RUNS = [
  run({ status: "cancelled", errorCode: "task_recovery_budget_exhausted",
        error: "Automatic recovery budget exhausted (attempts): attempts=1/1, turns=0/12" }),
  run({ status: "failed", errorCode: "adapter_failed", error: "Process adapter missing command" }),
  run({ status: "failed", errorCode: "adapter_failed", error: "Process adapter missing command" }),
];

describe("summarizeAgentTrouble", () => {
  /**
   * The complaint this exists for, verbatim: "HAL's dashboard shows only the
   * recovery-budget wrapper, and you have to click into the run to find the
   * cause. I nearly reported the wrong root cause off HAL's dashboard alone."
   */
  it("reports the cause underneath, not the recovery marker on top", () => {
    const t = summarizeAgentTrouble(HAL_RUNS as never, "HAL")!;
    expect(t.cause).toBe("Process adapter missing command");
    expect(t.code).toBe("adapter_failed");
    expect(t.lookedPastRecoveryMarker).toBe(true);
    // The budget wrapper must not be presented as the fault.
    expect(t.cause).not.toMatch(/recovery budget/i);
  });

  it("says so plainly for someone who is not going to read a stack trace", () => {
    expect(summarizeAgentTrouble(HAL_RUNS as never, "HAL")!.headline).toBe(
      "HAL stopped and has not run since.",
    );
  });

  /** An agent that is working is not in trouble, whatever its history holds. */
  it("returns nothing when the newest run succeeded", () => {
    const runs = [run({ status: "succeeded", error: null }), ...HAL_RUNS];
    expect(summarizeAgentTrouble(runs as never, "HAL")).toBeNull();
  });

  /** Scout's shape: a real error with no wrapper above it. */
  it("uses the newest run directly when there is no recovery marker", () => {
    const t = summarizeAgentTrouble(
      [run({ errorCode: "adapter_failed", error: "Cannot read properties of undefined (reading 'length')" })] as never,
      "Scout",
    )!;
    expect(t.cause).toBe("Cannot read properties of undefined (reading 'length')");
    expect(t.lookedPastRecoveryMarker).toBe(false);
  });

  /** Only markers and nothing else: do not dress a marker up as a diagnosis. */
  it("admits it when recovery markers are all there is", () => {
    const t = summarizeAgentTrouble(
      [run({ status: "cancelled", errorCode: "task_recovery_budget_exhausted", error: "budget" })] as never,
      "HAL",
    )!;
    expect(t.cause).toBeNull();
    expect(t.headline).toMatch(/automatic recovery gave up/i);
  });

  /**
   * A success ends the streak. An error from before the agent last worked is
   * not why it is failing now, and showing it would send someone after a fixed
   * problem.
   */
  it("does not reach back past a successful run for an older error", () => {
    const runs = [
      run({ status: "cancelled", errorCode: "task_recovery_budget_exhausted", error: "budget" }),
      run({ status: "succeeded", error: null }),
      run({ status: "failed", errorCode: "adapter_failed", error: "an old, already-fixed fault" }),
    ];
    const t = summarizeAgentTrouble(runs as never, "HAL")!;
    expect(t.cause).toBeNull();
    // nothing anywhere in the result reaches back past the success
    expect(JSON.stringify(t)).not.toMatch(/already-fixed/);
  });

  /**
   * The defect a steward found on the live page: it showed
   * "Process lost -- server may have restarted" under the heading "What the
   * adapter reported". The adapter reported nothing. `services/heartbeat.ts`
   * says so about its own code — "the reaper's inference, not an observation:
   * it fires when the server can no longer see the child, and after a restart
   * that is a guess."
   */
  describe("a lost process is the platform's fault, not the agent's", () => {
    const LOST = [
      run({
        status: "failed",
        errorCode: "process_lost",
        error: "Process lost -- server may have restarted",
      }),
    ];

    it("is classified as infrastructure, not as an adapter fault", () => {
      expect(summarizeAgentTrouble(LOST as never, "Scout")!.kind).toBe("infrastructure");
    });

    it("does not say the agent stopped, because it did not", () => {
      const t = summarizeAgentTrouble(LOST as never, "Scout")!;
      expect(t.headline).toBe("Scout's last run was cut short when the server restarted.");
      expect(t.headline).not.toMatch(/stopped and has not run since/);
    });

    it("still shows the recorded text, so nothing is hidden", () => {
      expect(summarizeAgentTrouble(LOST as never, "Scout")!.cause).toBe(
        "Process lost -- server may have restarted",
      );
    });

    /** A real adapter failure must keep the sharper framing. */
    it("leaves genuine adapter failures classified as adapter faults", () => {
      const t = summarizeAgentTrouble(
        [run({ errorCode: "adapter_failed", error: "Process adapter missing command" })] as never,
        "HAL",
      )!;
      expect(t.kind).toBe("adapter");
      expect(t.headline).toBe("HAL stopped and has not run since.");
    });
  });

  it("returns nothing when there are no runs at all", () => {
    expect(summarizeAgentTrouble([] as never, "HAL")).toBeNull();
  });
});
