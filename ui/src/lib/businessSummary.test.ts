import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "../adapters";
import { buildReadableTranscript } from "./readableTranscript";
import { buildBusinessSummary, describeToolGroup, plainExcerpt } from "./businessSummary";

const run: TranscriptEntry[] = [
  { kind: "init", ts: "2026-03-12T00:00:00.000Z", model: "claude-sonnet", sessionId: "sess_1" },
  { kind: "assistant", ts: "2026-03-12T00:00:01.000Z", text: "I'll check the **open issues** first." },
  { kind: "tool_call", ts: "2026-03-12T00:00:02.000Z", name: "Read", toolUseId: "t1", input: { file_path: "notes/a.md" } },
  { kind: "tool_result", ts: "2026-03-12T00:00:03.000Z", toolUseId: "t1", content: "a", isError: false },
  { kind: "tool_call", ts: "2026-03-12T00:00:03.500Z", name: "Read", toolUseId: "t2", input: { file_path: "notes/b.md" } },
  { kind: "tool_result", ts: "2026-03-12T00:00:03.600Z", toolUseId: "t2", content: "b", isError: false },
  { kind: "tool_call", ts: "2026-03-12T00:00:04.000Z", name: "Bash", toolUseId: "t3", input: { command: "pnpm test" } },
  { kind: "tool_result", ts: "2026-03-12T00:00:05.000Z", toolUseId: "t3", content: "FAIL", isError: true },
  { kind: "assistant", ts: "2026-03-12T00:00:06.000Z", text: "Decided to send the draft as is.\n\nNothing else is waiting." },
  {
    kind: "result",
    ts: "2026-03-12T00:01:05.000Z",
    text: "done",
    inputTokens: 1200,
    outputTokens: 340,
    cachedTokens: 0,
    costUsd: 0.0123,
    subtype: "success",
    isError: false,
    errors: [],
  },
];

describe("buildBusinessSummary", () => {
  it("turns the run into plain steps, a result and a cost, with no milestone labels", () => {
    const summary = buildBusinessSummary(buildReadableTranscript(run));
    expect(summary.steps.map((step) => [step.kind, step.title])).toEqual([
      ["said", "I'll check the open issues first."],
      ["did", "Read 2 files and ran a command"],
    ]);
    expect(summary.steps[1]!.failed).toBe(1);
    expect(summary.steps[1]!.detail).toHaveLength(3);
    expect(summary.finalMessage).toBe("Decided to send the draft as is.\n\nNothing else is waiting.");
    expect(summary.outcome).toEqual({ state: "done", label: "Finished", note: null });
    expect(summary.cost).toMatchObject({ inputTokens: 1200, outputTokens: 340, costUsd: 0.0123 });
    const text = JSON.stringify(summary);
    for (const label of ["Discover", "Proposal", "Negotiation", "Agreement", "Execution", "Settlement"]) {
      expect(text).not.toContain(label);
    }
  });

  it("prefers the run record's metered usage", () => {
    const summary = buildBusinessSummary(buildReadableTranscript(run), {
      usage: { inputTokens: 1500, outputTokens: 400, costUsd: 0.02, durationMs: 70_000 },
    });
    expect(summary.cost).toEqual({ durationMs: 70_000, inputTokens: 1500, outputTokens: 400, costUsd: 0.02 });
  });

  it("keeps every message as a step while the run is still working", () => {
    const live = run.slice(0, -1);
    const summary = buildBusinessSummary(buildReadableTranscript(live, true), { streaming: true });
    expect(summary.finalMessage).toBeNull();
    expect(summary.steps.at(-1)?.kind).toBe("said");
    expect(summary.outcome.state).toBe("working");
  });

  it("reports a failed run and a stopped run in plain words", () => {
    const failed: TranscriptEntry[] = [
      {
        kind: "result",
        ts: "2026-03-12T00:00:30.000Z",
        text: "Adapter exploded",
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        subtype: "error",
        isError: true,
        errors: ["Adapter exploded"],
      },
    ];
    expect(buildBusinessSummary(buildReadableTranscript(failed)).outcome).toEqual({
      state: "failed",
      label: "Did not finish",
      note: "Adapter exploded",
    });
    const noisy: TranscriptEntry[] = [
      { kind: "assistant", ts: "2026-03-12T00:00:01.000Z", text: "Working" },
      { kind: "stderr", ts: "2026-03-12T00:00:02.000Z", text: "Error: process terminated by signal SIGTERM" },
    ];
    const stopped = buildBusinessSummary(buildReadableTranscript(noisy), { stoppedReason: "Stopped manually" });
    expect(stopped.outcome).toEqual({ state: "stopped", label: "Stopped", note: "Stopped manually" });
    expect(JSON.stringify(stopped.steps)).not.toContain("SIGTERM");
  });

  it("redacts secrets in step text", () => {
    const secret = "SUPERSECRETvalue123";
    const summary = buildBusinessSummary(
      buildReadableTranscript([{ kind: "assistant", ts: "2026-03-12T00:00:01.000Z", text: `token=${secret}` }], true),
      { streaming: true },
    );
    expect(JSON.stringify(summary)).not.toContain(secret);
  });
});

describe("plain wording helpers", () => {
  it("strips markdown to one line", () => {
    expect(plainExcerpt("## Plan\n\n- **Book** the [ryokan](https://x.test)\n- `pay`")).toBe("Plan Book the ryokan pay");
  });

  it("names tool groups in plain words", () => {
    const item = (verb: string) => ({ summary: { verb, target: null, label: verb, isCommand: false } });
    expect(describeToolGroup([item("Ran")])).toBe("Ran a command");
    expect(describeToolGroup([item("Updated issue"), item("Updated issue")])).toBe("Updated issue (2 times)");
    expect(describeToolGroup([item("MCP: create_issue"), item("Fetched")])).toBe("Used create issue and opened a web page");
  });
});
