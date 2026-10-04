// @vitest-environment node

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptEntry } from "../../adapters";
import { ThemeProvider } from "../../context/ThemeContext";
import { RunTranscriptView } from "./RunTranscriptView";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(<ThemeProvider>{node}</ThemeProvider>);
}

const toolRun: TranscriptEntry[] = [
  { kind: "init", ts: "2026-03-12T00:00:00.000Z", model: "claude-sonnet", sessionId: "sess_1" },
  { kind: "thinking", ts: "2026-03-12T00:00:00.500Z", text: "secret plan of attack" },
  { kind: "assistant", ts: "2026-03-12T00:00:01.000Z", text: "Hello **world**" },
  { kind: "tool_call", ts: "2026-03-12T00:00:02.000Z", name: "Read", toolUseId: "t1", input: { file_path: "ui/src/App.tsx" } },
  { kind: "tool_result", ts: "2026-03-12T00:00:03.000Z", toolUseId: "t1", content: "import React", isError: false },
  { kind: "tool_call", ts: "2026-03-12T00:00:04.000Z", name: "Bash", toolUseId: "t2", input: { command: "bash -lc 'pnpm test'" } },
  { kind: "tool_result", ts: "2026-03-12T00:00:05.000Z", toolUseId: "t2", content: "FAIL app.test.ts\nmore detail", isError: true },
  { kind: "stderr", ts: "2026-03-12T00:00:06.000Z", text: "npm warn something harmless" },
  {
    kind: "result",
    ts: "2026-03-12T00:01:05.000Z",
    text: "## Summary\n\n- fixed deploy config",
    inputTokens: 1200,
    outputTokens: 340,
    cachedTokens: 0,
    costUsd: 0.0123,
    subtype: "success",
    isError: false,
    errors: [],
  },
];

describe("RunTranscriptView", () => {
  it("defaults to the readable mode", () => {
    const html = render(<RunTranscriptView entries={toolRun} />);
    expect(html).toContain('data-transcript-mode="readable"');
  });

  it("renders assistant text as markdown and tool calls as one-line summaries", () => {
    const html = render(<RunTranscriptView entries={toolRun} />);
    expect(html).toContain("<strong>world</strong>");
    expect(html).toContain("Ran 2 tools");
    // The failed call stays visible inside the folded group, with its first line.
    expect(html).toContain("pnpm test");
    expect(html).toContain("FAIL app.test.ts");
    expect(html).toContain('data-readable-tool="error"');
    expect(html).not.toContain("more detail");
  });

  it("hides thinking, init and harmless stderr behind one Details disclosure", () => {
    const html = render(<RunTranscriptView entries={toolRun} />);
    expect(html).toContain("Details (3)");
    expect(html).not.toContain("secret plan of attack");
    expect(html).not.toContain("npm warn something harmless");
    expect(html).not.toContain("sess_1");
  });

  it("renders the result entry as a compact footer", () => {
    const html = render(<RunTranscriptView entries={toolRun} />);
    expect(html).toContain("Completed · 1m 5s · 1.2k in / 340 out · $0.0123");
    expect(html).toContain("<h2>Summary</h2>");
  });

  // AgentDash (c3): a killed process reports "Failed" in the transcript's own
  // result line; a cancelled run's footer must read as a neutral stop instead.
  it("renders a neutral Stopped footer for a cancelled run", () => {
    const cancelledRun: TranscriptEntry[] = [
      { kind: "assistant", ts: "2026-03-12T00:00:01.000Z", text: "Working on it" },
      {
        kind: "result",
        ts: "2026-03-12T00:00:30.000Z",
        text: "Interrupted: process received SIGINT",
        inputTokens: 500,
        outputTokens: 100,
        cachedTokens: 0,
        costUsd: 0.004,
        subtype: "error",
        isError: true,
        errors: ["Interrupted: process received SIGINT"],
      },
    ];
    const html = render(<RunTranscriptView entries={cancelledRun} stoppedReason="Stopped manually" />);
    expect(html).toContain('data-readable-footer="ok"');
    expect(html).toContain("Stopped · 29s");
    expect(html).toContain("Stopped manually");
    expect(html).not.toContain("Failed");
    expect(html).not.toContain("process received SIGINT");
  });

  // AgentDash (c3 review): a killed process rarely gets to write a result
  // line — the stopped run still gets its neutral footer, and the stderr
  // noise the kill produced is not shown as a red error block.
  it("shows the stopped footer with no result line, and hides kill-noise error lines", () => {
    const stoppedWithoutResult: TranscriptEntry[] = [
      { kind: "assistant", ts: "2026-03-12T00:00:01.000Z", text: "Still working on it" },
      { kind: "stderr", ts: "2026-03-12T00:00:02.000Z", text: "Error: process terminated by signal SIGTERM" },
    ];
    const html = render(<RunTranscriptView entries={stoppedWithoutResult} stoppedReason="Stopped manually" />);
    expect(html).toContain('data-readable-footer="ok"');
    expect(html).toContain("Stopped");
    expect(html).toContain("Stopped manually");
    expect(html).not.toContain("SIGTERM");
    expect(html).not.toContain("process terminated");
  });

  it("still renders error lines on a run that was not stopped", () => {
    const noisyRun: TranscriptEntry[] = [
      { kind: "stderr", ts: "2026-03-12T00:00:02.000Z", text: "Error: real failure noise" },
    ];
    const html = render(<RunTranscriptView entries={noisyRun} />);
    expect(html).toContain("real failure noise");
  });

  it("keeps the red Failed footer for a genuinely failed run", () => {
    const failedRun: TranscriptEntry[] = [
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
    const html = render(<RunTranscriptView entries={failedRun} />);
    expect(html).toContain('data-readable-footer="error"');
    expect(html).toContain("Failed");
    expect(html).toContain("Adapter exploded");
  });

  it("treats the legacy nice mode as readable", () => {
    const html = render(<RunTranscriptView mode="nice" entries={toolRun} />);
    expect(html).toContain('data-transcript-mode="readable"');
  });

  it("keeps the raw view available", () => {
    const html = render(<RunTranscriptView mode="raw" entries={toolRun} />);
    expect(html).toContain('data-transcript-mode="raw"');
    expect(html).toContain("secret plan of attack");
    expect(html).toContain("tool_call");
  });

  it("windows large raw transcripts instead of rendering every entry at once", () => {
    const entries: TranscriptEntry[] = Array.from({ length: 500 }, (_, index) => ({
      kind: "stdout",
      ts: `2026-03-12T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
      text: `line-${index}`,
    }));

    const html = render(<RunTranscriptView mode="raw" entries={entries} />);

    expect(html).toContain("line-0");
    expect(html).toContain("line-179");
    expect(html).not.toContain("line-250");
    expect(html).not.toContain("line-499");
  });
});

// AgentDash (scan 4 lane O1, PR #990 review): Raw mode shows every entry, so
// every entry is redacted, and it says credentials are hidden.
describe("RunTranscriptView raw redaction", () => {
  const SECRET = "SUPERSECRETvalue123";
  const entries: TranscriptEntry[] = [
    { kind: "assistant", ts: "2026-03-12T00:00:01.000Z", text: `Using token=${SECRET}` },
    {
      kind: "tool_call",
      ts: "2026-03-12T00:00:02.000Z",
      name: "Bash",
      toolUseId: "t1",
      input: { command: `curl -H "Authorization: Bearer ${SECRET}" https://x.test`, env: { API_KEY: SECRET } },
    },
    { kind: "tool_result", ts: "2026-03-12T00:00:03.000Z", toolUseId: "t1", content: `{"access_token":"${SECRET}"}`, isError: false },
    { kind: "stdout", ts: "2026-03-12T00:00:04.000Z", text: `DATABASE_URL=postgres://app:${SECRET}@db/x` },
    { kind: "stderr", ts: "2026-03-12T00:00:05.000Z", text: `Error: mysql -uroot -p${SECRET} failed` },
  ];

  it("redacts tool calls, results, stdout, stderr and assistant text, with a note", () => {
    const html = render(<RunTranscriptView entries={entries} mode="raw" />);
    expect(html).not.toContain(SECRET);
    expect(html).toContain("***REDACTED***");
    expect(html).toContain("Credentials in this log are hidden.");
  });

  it("redacts the readable view (messages, Details and error lines) too", () => {
    const html = render(<RunTranscriptView entries={entries} mode="readable" />);
    expect(html).not.toContain(SECRET);
  });
});
