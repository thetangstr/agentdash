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
        "hermes_local",
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
    expect(
      mergeHeartbeatRunResultJson(null, "line one\r\nline two"),
    ).toEqual({ summary: "line one\nline two" });
  });

  // AgentDash (review-1025 item 1): an answer that ends without a final
  // newline leaves its last line unterminated — that tail is not LF evidence,
  // so a CRLF document must not read as "mixed" and be stripped to its last
  // line. dispatch-llm trims stdout before this runs, so every CRLF CoS
  // answer arrives exactly like this.
  it("keeps a CRLF answer whose last line has no terminator", () => {
    expect(
      mergeHeartbeatRunResultJson(null, "a\r\nb"),
    ).toEqual({ summary: "a\nb" });
    expect(
      mergeHeartbeatRunResultJson(null, "line one\r\nline two"),
    ).toEqual({ summary: "line one\nline two" });
    expect(
      mergeHeartbeatRunResultJson(
        null,
        "Para one.\r\n\r\nPara two.\r\nPara three.",
      ),
    ).toEqual({ summary: "Para one.\n\nPara two.\nPara three." });
    // A fenced payload the way revise-plan emits one, CRLF throughout.
    const reply = "Updated based on your feedback.\r\n```json\r\n{\"plan\":{}}\r\n```";
    expect(mergeHeartbeatRunResultJson(null, reply)).toEqual({
      summary: "Updated based on your feedback.\n```json\n{\"plan\":{}}\n```",
    });
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

  // AgentDash (cos-followups review): the runtime signs its own status writes
  // with \r\n while the agent's answer uses \n, so a CRLF line in an
  // otherwise-LF document is subprocess chatter even without a glyph.
  it("strips a glyph-less CRLF status line from an LF answer", () => {
    expect(
      mergeHeartbeatRunResultJson(
        null,
        "Loading MCP servers…\r\nMoved the ticket to review.",
      ),
    ).toEqual({ summary: "Moved the ticket to review." });
  });

  it("strips a ✗ CRLF status line — the line ending is the signature, not the glyph", () => {
    expect(
      mergeHeartbeatRunResultJson(
        null,
        "✗ mcp server workspace-search failed\r\nAll 42 checks pass.",
      ),
    ).toEqual({ summary: "All 42 checks pass." });
  });

  it("keeps an ℹ line that starts real prose — info is not a warning", () => {
    const text = "ℹ Note: the migration is reversible";
    expect(mergeHeartbeatRunResultJson(null, text)).toEqual({ summary: text });
    const multi = "ℹ Note: the migration is reversible\nThe rollback takes two minutes.";
    expect(mergeHeartbeatRunResultJson(null, multi)).toEqual({ summary: multi });
  });

  it("still strips an ℹ line when it carries the CRLF machine signature", () => {
    expect(
      mergeHeartbeatRunResultJson(
        null,
        "ℹ no fallback adapter configured\r\nShipped the fix.",
      ),
    ).toEqual({ summary: "Shipped the fix." });
  });

  // AgentDash (cos-followups-2 item 3): the CRLF shape check is for
  // unmistakable machine noise — glyph checklists, prose notes and a sentence
  // that ends in "…" are real answers even when they arrive CRLF-terminated.
  it("keeps a CRLF-authored ✓ checklist — ✓ is not a machine signature on its own", () => {
    expect(
      mergeHeartbeatRunResultJson(null, "✓ Fixed X\r\n✓ Added tests\r\n→ Next: roll it out"),
    ).toEqual({ summary: "✓ Fixed X\n✓ Added tests\n→ Next: roll it out" });
  });

  it("keeps a CRLF-authored ℹ Note — prose notes are not diagnostics", () => {
    expect(
      mergeHeartbeatRunResultJson(null, "ℹ Note: reversible\r\nRollback 2 min"),
    ).toEqual({ summary: "ℹ Note: reversible\nRollback 2 min" });
  });

  it("keeps a CRLF line that ends in … when it is prose, not a progress line", () => {
    expect(
      mergeHeartbeatRunResultJson(null, "Let me check…\r\nThe build is green."),
    ).toEqual({ summary: "Let me check…\nThe build is green." });
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

  // AgentDash (review-1019 + review-1022): the ✗/→ glyph rule is scoped to
  // Hermes — its runtime writes those step diagnostics to stdout on plain LF
  // lines — while every other adapter keeps leading pointer prose. A "✓
  // <status word>" line is machine noise on every adapter, and a bare "✓
  // Fixed X" is agent prose even on Hermes.
  it("strips the leading ✗/→ glyph run for a hermes_local run", () => {
    const noisy = "✓ loaded config\n  ✗ tool call failed, retrying\n→ resuming\nDone — deployed.";
    expect(mergeHeartbeatRunResultJson(null, noisy, "hermes_local")).toEqual({
      summary: "Done — deployed.",
    });
  });

  it("keeps the same leading ✗/→ lines as prose on every other adapter", () => {
    const text = "✗ tool call failed, retrying\n→ resuming\nDone — deployed.";
    for (const adapterType of [undefined, null, "claude_local", "process"]) {
      expect(mergeHeartbeatRunResultJson(null, text, adapterType)).toEqual({
        summary: text,
      });
    }
  });

  it("keeps a ✓ checklist summary even for a hermes_local run", () => {
    // Finding review-1022 #2: Hermes is an LLM too — a "✓ Fixed X" checklist
    // is its answer, not runtime chatter. Only status-word ✓ lines strip.
    const text = "✓ Fixed the deploy script\n✓ Added tests\nHere's what shipped.";
    expect(mergeHeartbeatRunResultJson(null, text, "hermes_local")).toEqual({
      summary: text,
    });
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

  // AgentDash (c4-stops): the hosted pass showed run summaries that were raw
  // command output. Leading transport plumbing never survives.
  it("strips leading stream markers, shell echoes and exit codes", () => {
    expect(
      mergeHeartbeatRunResultJson(
        null,
        "--- stderr ---\n$ pnpm test\nexit_code: 0\nAll 42 checks pass and the fix is shipped.",
      ),
    ).toEqual({ summary: "All 42 checks pass and the fix is shipped." });
  });

  it("strips a leading Codex-style exec header block", () => {
    expect(
      mergeHeartbeatRunResultJson(
        null,
        "command: pnpm -r typecheck\nstatus: completed\nexit_code: 0\n\nTypecheck is clean.",
      ),
    ).toEqual({ summary: "Typecheck is clean." });
  });

  it("strips leading env-assignment lines — 'Using DATABASE_URL=…' is plumbing", () => {
    expect(
      mergeHeartbeatRunResultJson(
        null,
        "Reading the task. Using DATABASE_URL=postgres://localhost/db\nMigrated the schema and seeded the demo company.",
      ),
    ).toEqual({ summary: "Migrated the schema and seeded the demo company." });
  });

  it("keeps a first line that merely names an env var without assigning it", () => {
    const text = "DATABASE_URL now points at the staging database; migration applied.";
    expect(mergeHeartbeatRunResultJson(null, text)).toEqual({ summary: text });
  });

  it("strips leading ✗/→ lines for hermes_local but keeps them elsewhere", () => {
    const row = { summary: "✗ tool call failed, retrying\n→ resuming\nAll 42 checks pass." };
    expect(summarizeHeartbeatRunResultJson(row, "hermes_local")).toEqual({
      summary: "All 42 checks pass.",
    });
    expect(summarizeHeartbeatRunResultJson(row)).toEqual(row);
  });
});

describe("buildHeartbeatRunIssueComment status lines", () => {
  it("skips a chatter-only summary and falls back to the result", () => {
    expect(
      buildHeartbeatRunIssueComment(
        {
          summary: "✓ session resumed\r\n",
          result: "Shipped the fix.",
        },
        "hermes_local",
      ),
    ).toBe("Shipped the fix.");
  });
});
