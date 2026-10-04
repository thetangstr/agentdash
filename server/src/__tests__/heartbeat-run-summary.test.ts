import { describe, expect, it } from "vitest";
import {
  summarizeHeartbeatRunResultJson,
  buildHeartbeatRunIssueComment,
  mergeHeartbeatRunResultJson,
} from "../services/heartbeat-run-summary.js";

describe("summarizeHeartbeatRunResultJson", () => {
  it("truncates text fields and preserves cost aliases", () => {
    const summary = summarizeHeartbeatRunResultJson({
      summary: "a".repeat(600),
      result: "ok",
      message: "done",
      error: "failed",
      total_cost_usd: 1.23,
      cost_usd: 0.45,
      costUsd: 0.67,
      stopReason: "timeout",
      effectiveTimeoutSec: 30,
      timeoutConfigured: true,
      timeoutFired: true,
      nested: { ignored: true },
    });

    expect(summary).toEqual({
      summary: "a".repeat(500),
      result: "ok",
      message: "done",
      error: "failed",
      total_cost_usd: 1.23,
      cost_usd: 0.45,
      costUsd: 0.67,
      stopReason: "timeout",
      effectiveTimeoutSec: 30,
      timeoutConfigured: true,
      timeoutFired: true,
    });
  });

  it("returns null for non-object and irrelevant payloads", () => {
    expect(summarizeHeartbeatRunResultJson(null)).toBeNull();
    expect(summarizeHeartbeatRunResultJson(["nope"] as unknown as Record<string, unknown>)).toBeNull();
    expect(summarizeHeartbeatRunResultJson({ nested: { only: "ignored" } })).toBeNull();
  });
});

describe("buildHeartbeatRunIssueComment", () => {
  it("uses the final summary text for issue comments on successful runs", () => {
    const comment = buildHeartbeatRunIssueComment({
      summary: "## Summary\n\n- fixed deploy config\n- posted issue update",
    });

    expect(comment).toContain("## Summary");
    expect(comment).toContain("- fixed deploy config");
    expect(comment).not.toContain("Run summary");
  });

  it("falls back to result or message when summary is missing", () => {
    expect(buildHeartbeatRunIssueComment({ result: "done" })).toBe("done");
    expect(buildHeartbeatRunIssueComment({ message: "completed" })).toBe("completed");
  });

  it("returns null when there is no usable final text", () => {
    expect(buildHeartbeatRunIssueComment({ costUsd: 1.2 })).toBeNull();
  });
});

describe("mergeHeartbeatRunResultJson", () => {
  it("adds adapter summaries into stored result json for comment posting", () => {
    const merged = mergeHeartbeatRunResultJson(
      { stdout: "raw stdout", stderr: "" },
      "## Summary\n\n1. first thing\n2. second thing",
    );

    expect(merged).toEqual({
      stdout: "raw stdout",
      stderr: "",
      summary: "## Summary\n\n1. first thing\n2. second thing",
    });
    expect(buildHeartbeatRunIssueComment(merged)).toBe("## Summary\n\n1. first thing\n2. second thing");
  });

  it("creates a result payload when only a summary exists", () => {
    expect(mergeHeartbeatRunResultJson(null, "done")).toEqual({ summary: "done" });
  });

  it("does not overwrite an explicit summary already returned by the adapter", () => {
    expect(
      mergeHeartbeatRunResultJson(
        { summary: "adapter result", stdout: "raw stdout" },
        "fallback summary",
      ),
    ).toEqual({
      summary: "adapter result",
      stdout: "raw stdout",
    });
  });

  // AgentDash (canary): the Hermes adapter picks cleaned stdout as its
  // response, so a leading runtime warning became the persisted run summary.
  // A status line is never the summary.
  it("strips a leading runtime warning from the adapter summary", () => {
    expect(
      mergeHeartbeatRunResultJson(
        null,
        "⚠ tirith security scanner enabled but not available — command scanning will use pattern matching only\r\nMoved the ticket to review and posted the diff for the reviewer.",
      ),
    ).toEqual({
      summary: "Moved the ticket to review and posted the diff for the reviewer.",
    });
  });

  it("drops a summary that was only a status line", () => {
    expect(
      mergeHeartbeatRunResultJson(
        null,
        "⚠ tirith security scanner enabled but not available — command scanning will use pattern matching only\r\n",
      ),
    ).toBeNull();
    expect(
      mergeHeartbeatRunResultJson(
        { summary: "⚠ scanner unavailable", result: "real output" },
        null,
      ),
    ).toEqual({ result: "real output" });
  });

  it("strips chatter from a summary already inside resultJson", () => {
    expect(
      mergeHeartbeatRunResultJson(
        { summary: "✓ loading tools\r\nAll 42 checks pass.", stdout: "raw" },
        "ignored fallback",
      ),
    ).toEqual({ summary: "All 42 checks pass.", stdout: "raw" });
  });

  it("leaves a warning mid-summary alone — only a leading run is chatter", () => {
    const text = "Deployed the fix.\n⚠ scanner unavailable";
    expect(mergeHeartbeatRunResultJson(null, text)).toEqual({ summary: text });
  });

  // AgentDash (review): the glyph set must only cover runtime diagnostics. A
  // "✓" checklist or a "→ Next:" pointer is an agent's own prose, and a
  // CRLF-authored summary must not vanish.
  it("keeps a checklist summary — ✓ and → are agent prose, not runtime noise", () => {
    const text = "✓ Fixed the deploy script\n✓ Added tests\n→ Next: roll it out";
    expect(mergeHeartbeatRunResultJson(null, text)).toEqual({ summary: text });
  });

  it("keeps a CRLF-authored summary and normalises the line endings", () => {
    expect(
      mergeHeartbeatRunResultJson(null, "line one\r\nline two\r\n"),
    ).toEqual({ summary: "line one\nline two" });
  });

  it("still treats a lone carriage return as an in-place redraw", () => {
    expect(
      mergeHeartbeatRunResultJson(
        null,
        "✓ session resumed\rDeploy finished and the diff is posted.",
      ),
    ).toEqual({ summary: "Deploy finished and the diff is posted." });
  });

  it("still strips a mixed warning that was redrawn over a real answer", () => {
    expect(
      mergeHeartbeatRunResultJson(
        null,
        "⚠ scanner unavailable\r\nAll 42 checks pass.",
      ),
    ).toEqual({ summary: "All 42 checks pass." });
  });

  it("strips a warning-only result and message, not just the summary", () => {
    expect(
      mergeHeartbeatRunResultJson(
        {
          result: "⚠ tirith security scanner enabled but not available",
          message: "real message",
        },
        null,
      ),
    ).toEqual({ message: "real message" });
  });
});

describe("summarizeHeartbeatRunResultJson status lines", () => {
  it("never serves a leading status line as the summary", () => {
    const summary = summarizeHeartbeatRunResultJson({
      summary: "⚠ tirith security scanner enabled but not available",
      result: "real output",
    });

    expect(summary).toEqual({ result: "real output" });
  });
});

describe("buildHeartbeatRunIssueComment status lines", () => {
  it("skips a chatter-only summary and falls back to the result", () => {
    expect(
      buildHeartbeatRunIssueComment({
        summary: "✓ session resumed\r\n",
        result: "Shipped the fix.",
      }),
    ).toBe("Shipped the fix.");
  });
});
