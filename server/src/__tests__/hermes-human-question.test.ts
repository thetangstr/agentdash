import { describe, expect, it } from "vitest";
import {
  HERMES_HUMAN_QUESTION_ERROR_CODE,
  createHermesHumanQuestionGuard,
  detectHermesHumanQuestionFallback,
  failClosedOnHermesHumanQuestionFallback,
  stripAnsi,
} from "../adapters/hermes-human-question.js";

/**
 * AgentDash (AGE-13): Hermes's `clarify` tool is a terminal prompt nobody is
 * watching in a headless run; its fallback lets the agent decide. These tests
 * pin the detector to Hermes's real output and the fail-closed transform to
 * "refuse the run, keep everything else".
 */
describe("hermes human-question fallback detection", () => {
  it("recognises the TUI timeout line through its dim escape codes", () => {
    const line = "\n\u001b[2m(clarify timed out after 120s — agent will decide)\u001b[0m\n";
    expect(stripAnsi(line)).toContain("(clarify timed out after 120s — agent will decide)");
    expect(detectHermesHumanQuestionFallback(line)).toBe("clarify timed out after 120s");
  });

  it("recognises the one-shot fallback that hands the decision back immediately", () => {
    const chunk =
      "[oneshot mode: no user available. Pick the best option from ['a', 'b'] using your own judgment and continue.]";
    expect(detectHermesHumanQuestionFallback(chunk)).toBe("[oneshot mode: no user available");
  });

  it("recognises the tool result Hermes hands the model after a timeout", () => {
    const chunk =
      "The user did not provide a response within the time limit. Use your best judgement to make the choice and proceed.";
    expect(detectHermesHumanQuestionFallback(chunk)).toBe(
      "did not provide a response within the time limit",
    );
  });

  it("ignores ordinary prose about deciding, including prose about the agent deciding", () => {
    expect(detectHermesHumanQuestionFallback("The steward will decide the launch date.")).toBeNull();
    expect(detectHermesHumanQuestionFallback("I asked the question in the issue and stopped.")).toBeNull();
    // A model in an agent product says this all the time; it is not Hermes's callback.
    expect(
      detectHermesHumanQuestionFallback(
        "Given the two remediation paths, the agent will decide which one to apply based on the run state.",
      ),
    ).toBeNull();
    expect(detectHermesHumanQuestionFallback("In this workflow the agent will decide the next step.")).toBeNull();
    expect(detectHermesHumanQuestionFallback("")).toBeNull();
  });

  it("still recognises the callback's tail on its own, as Hermes prints it", () => {
    expect(detectHermesHumanQuestionFallback("(clarify timed out — agent will decide)")).toBe("— agent will decide)");
  });
});

describe("failing a run closed on the fallback", () => {
  const cleanResult = {
    exitCode: 0,
    signal: null,
    timedOut: false,
    sessionId: "hermes-session-1",
    usage: { inputTokens: 10, outputTokens: 5 },
  };

  it("does nothing without evidence", () => {
    expect(failClosedOnHermesHumanQuestionFallback(cleanResult, [])).toBe(cleanResult);
  });

  it("turns a clean exit into an explicit failure and keeps the rest of the result", () => {
    const failed = failClosedOnHermesHumanQuestionFallback(cleanResult, ["clarify timed out after 120s"]);
    expect(failed.errorCode).toBe(HERMES_HUMAN_QUESTION_ERROR_CODE);
    expect(failed.errorMessage).toContain("clarify timed out after 120s");
    expect(failed.errorMessage).toContain("ask_user_questions");
    expect(failed.errorMeta).toEqual({ humanQuestionFallback: "clarify timed out after 120s" });
    expect(failed.exitCode).toBe(0);
    expect(failed.sessionId).toBe("hermes-session-1");
    expect(failed.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("keeps an adapter's own failure diagnosis and records the fallback beside it", () => {
    const alreadyFailed = { ...cleanResult, exitCode: 1, errorCode: "adapter_failed", errorMessage: "crashed" };
    const failed = failClosedOnHermesHumanQuestionFallback(alreadyFailed, ["agent will decide"]);
    expect(failed.errorCode).toBe("adapter_failed");
    expect(failed.errorMessage).toBe("crashed");
    expect(failed.errorMeta).toEqual({ humanQuestionFallback: "agent will decide" });
  });
});

describe("the per-run guard", () => {
  it("forwards every chunk, announces the first fallback once, and fails the result", async () => {
    const seen: Array<{ stream: string; chunk: string }> = [];
    const guard = createHermesHumanQuestionGuard(async (stream, chunk) => {
      seen.push({ stream, chunk });
    });

    await guard.onLog("stdout", "thinking...\n");
    await guard.onLog("stdout", "(clarify timed out after 120s — agent will decide)\n");
    await guard.onLog("stdout", "(clarify timed out after 120s — agent will decide)\n");
    await guard.onLog("stdout", "done\n");

    expect(seen.filter((entry) => entry.chunk.startsWith("[agentdash]"))).toHaveLength(1);
    expect(seen.map((entry) => entry.chunk)).toContain("thinking...\n");
    expect(seen.map((entry) => entry.chunk)).toContain("done\n");
    expect(guard.evidence).toHaveLength(2);

    const failed = guard.failClosed({ exitCode: 0, signal: null, timedOut: false });
    expect(failed.errorCode).toBe(HERMES_HUMAN_QUESTION_ERROR_CODE);
  });

  it("is inert for a run that never hit the fallback", async () => {
    const guard = createHermesHumanQuestionGuard(async () => {});
    await guard.onLog("stdout", "all good\n");
    const result = { exitCode: 0, signal: null, timedOut: false };
    expect(guard.failClosed(result)).toBe(result);
  });
});
