import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { buildTranscript, type RunLogChunk } from "../transcript";
import { hermesLocalUIAdapter } from "./index";
import { createHermesStdoutParser } from "./parse-stdout";

// Samples are sanitised from real Hermes run logs (paths, ids and issue text
// replaced). Each chunk is what the server wrote to the run log.

function at(seconds: number): string {
  return new Date(Date.UTC(2026, 9, 1, 22, 0, 0) + seconds * 1000).toISOString();
}

function kinds(entries: TranscriptEntry[]): string[] {
  return entries.map((entry) => entry.kind);
}

function stdout(seconds: number, chunk: string): RunLogChunk {
  return { ts: at(seconds), stream: "stdout", chunk };
}

describe("hermes_local transcript: stream-json runs", () => {
  const chunks: RunLogChunk[] = [
    stdout(0, '[paperclip] No project or prior session workspace was available. Using fallback workspace "/home/agent/workspaces/w-1" for this run.\n'),
    stdout(0, "[hermes] Starting Hermes Agent (model=glm-5.3-flash, provider=zai [adapterConfig], timeout=3600s)\n"),
    stdout(1, '{"type": "system", "subtype": "init", "model": "glm-5.3-flash", "session_id": "20261001_231546_52cd79", "timestamp": 1790921746825}\n'),
    stdout(2, '{"type": "text", "text": "\\n\\nChecking the assigned issue first.", "timestamp": 1790921747000}\n'),
    stdout(3, '{"type": "tool_use", "name": "terminal", "input": {"command": "curl -s \\"$PAPERCLIP_API_URL/issues/ISS-1\\""}, "timestamp": 1790921757363}\n'),
    stdout(4, '{"type": "tool_result", "name": "terminal", "output": "{\\"output\\": \\"{\\\\\\"identifier\\\\\\": \\\\\\"ISS-1\\\\\\"}\\", \\"exit_code\\": 0, \\"error\\": null}", "duration_ms": 83, "is_error": false, "timestamp": 1790921757447}\n'),
    stdout(5, '{"type": "tool_use", "name": "read_file", "input": {"path": "docs/missing.md"}, "timestamp": 1790921758000}\n'),
    stdout(6, '{"type": "tool_result", "name": "read_file", "output": "{\\"output\\": \\"\\", \\"exit_code\\": 1, \\"error\\": \\"File not found: docs/missing.md\\"}", "duration_ms": 4, "is_error": true, "timestamp": 1790921758100}\n'),
    stdout(7, '{"type": "text", "text": "Done. ISS-1", "timestamp": 1790921761223}\n'),
    stdout(7, '{"type": "text", "text": " is triaged.", "timestamp": 1790921761285}\n'),
    stdout(8, '{"type": "result", "session_id": "20261001_231546_52cd79", "exit_code": 0, "text": "Done. ISS-1 is triaged.", "tokens": {"input": 484, "output": 196, "total": 38056, "cache_read": 37376, "cache_write": 0}, "duration_ms": 14620, "timestamp": 1790921761445}\n'),
    stdout(8, "\nsession_id: 20261001_231546_52cd79\n"),
    stdout(8, "[hermes] Exit code: 0, timed out: false\n"),
  ];

  const entries = buildTranscript(chunks, hermesLocalUIAdapter);

  it("produces init, tool calls with their results, assistant text and a usage result", () => {
    expect(kinds(entries)).toEqual([
      "system",
      "system",
      "init",
      "assistant",
      "tool_call",
      "tool_result",
      "tool_call",
      "tool_result",
      "assistant",
      "result",
      "system",
      "system",
    ]);
    expect(entries).not.toContainEqual(expect.objectContaining({ kind: "stdout" }));
  });

  it("pairs each tool call with its result and unwraps Hermes' output envelope", () => {
    const [shellCall, shellResult, readCall, readResult] = entries.filter(
      (entry) => entry.kind === "tool_call" || entry.kind === "tool_result",
    );
    expect(shellCall).toMatchObject({ kind: "tool_call", name: "terminal", input: { command: 'curl -s "$PAPERCLIP_API_URL/issues/ISS-1"' } });
    expect(shellResult).toMatchObject({ kind: "tool_result", toolName: "terminal", content: '{"identifier": "ISS-1"}', isError: false });
    expect(shellResult && "toolUseId" in shellResult && shellResult.toolUseId).toBe(
      shellCall && "toolUseId" in shellCall && shellCall.toolUseId,
    );
    expect(readCall).toMatchObject({ kind: "tool_call", name: "read_file" });
    expect(readResult).toMatchObject({
      kind: "tool_result",
      toolName: "read_file",
      content: "File not found: docs/missing.md\nexit code 1",
      isError: true,
    });
  });

  it("merges streamed text deltas into one assistant message without the leading blank lines", () => {
    const assistant = entries.filter((entry) => entry.kind === "assistant");
    expect(assistant.map((entry) => entry.kind === "assistant" && entry.text)).toEqual([
      "Checking the assigned issue first.",
      "Done. ISS-1 is triaged.",
    ]);
  });

  it("carries the token usage on the result entry", () => {
    const result = entries.find((entry) => entry.kind === "result");
    expect(result).toMatchObject({
      kind: "result",
      text: "Done. ISS-1 is triaged.",
      inputTokens: 484,
      outputTokens: 196,
      cachedTokens: 37376,
      subtype: "success",
      isError: false,
      errors: [],
    });
  });

  it("marks a failed run's result as an error with the reason", () => {
    const failed = buildTranscript(
      [
        stdout(0, '{"type": "system", "subtype": "init", "model": "glm-5.3-flash", "session_id": "s-err", "timestamp": 1}\n'),
        stdout(1, '{"type": "result", "session_id": "s-err", "exit_code": 1, "text": "", "tokens": {"input": 0, "output": 0, "total": 0, "cache_read": 0, "cache_write": 0}, "duration_ms": 900, "error": "Provider returned 401 Unauthorized", "timestamp": 2}\n'),
      ],
      hermesLocalUIAdapter,
    );
    expect(failed.at(-1)).toMatchObject({
      kind: "result",
      isError: true,
      subtype: "error",
      errors: ["Provider returned 401 Unauthorized"],
    });
  });
});

describe("hermes_local transcript: plain -Q text runs (old logs and older Hermes)", () => {
  it("renders a multi-line final answer as one markdown assistant message", () => {
    const entries = buildTranscript(
      [
        stdout(0, "[hermes] Starting Hermes Agent (model=glm-5.3-flash, provider=zai [adapterConfig], timeout=3600s)\n"),
        { ts: at(60), stream: "stderr", chunk: "\nsession_id: 20261001_153250_9e7585\n" },
        stdout(
          60,
          "ISS-235 daily digest — completed this run:\n\n**What I did**\n\n1. **Resolved the DB access path.** Used the pooler.\n2. **Ran read-only queries.** Nothing was written.\n\n| metric | value |\n|---|---|\n| signups | 12 |\n\n```sql\nSELECT count(*)\nFROM users;\n```\n",
        ),
        stdout(60, "[hermes] Exit code: 0, timed out: false\n"),
      ],
      hermesLocalUIAdapter,
    );
    expect(kinds(entries)).toEqual(["system", "stderr", "assistant", "system"]);
    const answer = entries[2];
    expect(answer).toMatchObject({ kind: "assistant" });
    expect(answer && answer.kind === "assistant" && answer.text).toBe(
      [
        "ISS-235 daily digest — completed this run:",
        "",
        "**What I did**",
        "",
        "1. **Resolved the DB access path.** Used the pooler.",
        "2. **Ran read-only queries.** Nothing was written.",
        "",
        "| metric | value |",
        "|---|---|",
        "| signups | 12 |",
        "",
        "```sql",
        "SELECT count(*)",
        "FROM users;",
        "```",
      ].join("\n"),
    );
  });

  it("turns Hermes' live display into thinking, diff and warnings instead of answer text", () => {
    const entries = buildTranscript(
      [
        stdout(0, "[hermes] Starting Hermes Agent (model=glm-5.2, provider=auto [auto], timeout=1800s)\n"),
        stdout(1, "\r\n\u001b[2m┌─ Reasoning ──────────────────────────────┐\u001b[0m\r\n"),
        stdout(1, "The user wants me to check for assigned work.\r\n"),
        stdout(1, "Let me run that command.\r\n"),
        stdout(2, "\u001b[2m└──────────────────────────────────────────┘\u001b[0m\r\n"),
        stdout(3, "  ┊ review diff\r\n"),
        stdout(3, "a/src/services/client.py → b/src/services/client.py\r\n"),
        stdout(3, "@@ -10,3 +10,4 @@\r\n"),
        stdout(3, "         retries = 1\r\n-        timeout = 5\r\n+        timeout = 30\r\n+        backoff = 2\r\n         return retries\r\n"),
        stdout(4, "  ⏱ Timeout — denying command\r\n"),
        stdout(4, "💻 Completed\r\n"),
        stdout(5, "\nsession_id: 20260928_113153_930c8f\n"),
        stdout(5, "ISS-3 is complete. Here's the summary:\n\n- Raised the client timeout.\n"),
      ],
      hermesLocalUIAdapter,
    );
    expect(kinds(entries)).toEqual([
      "system",
      "thinking",
      "diff",
      "diff",
      "diff",
      "diff",
      "diff",
      "diff",
      "diff",
      "stderr",
      "system",
      "assistant",
    ]);
    expect(entries[1]).toMatchObject({ kind: "thinking", text: "The user wants me to check for assigned work.\nLet me run that command." });
    expect(entries.filter((entry) => entry.kind === "diff").map((entry) => entry.kind === "diff" && entry.changeType)).toEqual([
      "file_header",
      "hunk",
      "context",
      "remove",
      "add",
      "add",
      "context",
    ]);
    expect(entries.at(-1)).toMatchObject({
      kind: "assistant",
      text: "ISS-3 is complete. Here's the summary:\n\n- Raised the client timeout.",
    });
    expect(JSON.stringify(entries)).not.toContain("\u001b[");
    expect(entries).not.toContainEqual(expect.objectContaining({ kind: "stdout" }));
  });

  it("ends a diff preview at the answer in old logs that have no session_id boundary", () => {
    const parser = createHermesStdoutParser();
    const lines: Array<[number, string]> = [
      [0, "┊ review diff"],
      [0, "a/app.ts → b/app.ts"],
      // The hunk counts a blank context line the run log dropped.
      [0, "@@ -1,3 +1,4 @@"],
      [0, "import a from 'a';"],
      [0, "+import b from 'b';"],
      [0, "export default a;"],
      [40, "ISS-7 is complete. Here's the summary:"],
    ];
    const entries = lines.flatMap(([seconds, line]) => parser.parseLine(line, at(seconds)));
    expect(entries.at(-1)).toMatchObject({ kind: "assistant", text: "ISS-7 is complete. Here's the summary:" });
  });

  it("renders a '- Fixed X' bullet list after a diff preview as assistant text", () => {
    // Late answer: the hunk is short by a dropped blank context line, and the
    // answer's bullets start with "-", which a diff would read as removals.
    const late = createHermesStdoutParser();
    const lateEntries = (
      [
        [0, "┊ review diff"],
        [0, "a/app.ts → b/app.ts"],
        [0, "@@ -1,4 +1,4 @@"],
        [0, "import a from 'a';"],
        [0, "-const x = 1;"],
        [0, "+const x = 2;"],
        [30, "- Fixed X"],
        [30, "- Fixed Y"],
        [30, "- Fixed Z"],
      ] as Array<[number, string]>
    ).flatMap(([seconds, line]) => late.parseLine(line, at(seconds)));
    expect(lateEntries.filter((entry) => entry.kind === "diff")).toHaveLength(5);
    expect(lateEntries.filter((entry) => entry.kind === "assistant").map((entry) => entry.kind === "assistant" && entry.text).join("")).toBe(
      "- Fixed X\n- Fixed Y\n- Fixed Z",
    );

    // Same instant, no time gap: the hunk counts alone stop the diff from
    // swallowing more "-" lines than the hunk had removals left.
    const sameInstant = buildTranscript(
      [
        stdout(0, "  ┊ review diff\r\na/app.ts → b/app.ts\r\n@@ -1,2 +1,2 @@\r\n-const x = 1;\r\n+const x = 2;\r\n context();\r\n"),
        stdout(0, "- Fixed X\n- Fixed Y\n"),
      ],
      hermesLocalUIAdapter,
    );
    expect(kinds(sameInstant)).toEqual(["diff", "diff", "diff", "diff", "diff", "assistant"]);
    expect(sameInstant.at(-1)).toMatchObject({ kind: "assistant", text: "- Fixed X\n- Fixed Y" });
  });

  it("keeps the vendored tool-line parsing for non-quiet logs", () => {
    const entries = buildTranscript(
      [
        stdout(0, "  [done] ┊ 💻 $         ls -la  0.1s (0.5s)\n"),
        stdout(1, "  ┊ 💻 $         false [exit 1]  0.2s\n"),
        stdout(2, "  ┊ 💬 Looking at the repo now.\n"),
      ],
      hermesLocalUIAdapter,
    );
    expect(kinds(entries)).toEqual(["tool_call", "tool_result", "tool_call", "tool_result", "assistant"]);
    // Same entries the vendored parser produced before this wrapper existed.
    expect(entries[0]).toMatchObject({ kind: "tool_call", input: { detail: expect.stringContaining("ls -la") } });
    expect(entries[3]).toMatchObject({ kind: "tool_result", isError: true });
    expect(entries[4]).toMatchObject({ kind: "assistant", text: "Looking at the repo now." });
  });

  it("keeps a JSON line in the agent's answer as text", () => {
    const entries = buildTranscript([stdout(0, '{"type": "text", "text": "not an event"}\n')], hermesLocalUIAdapter);
    expect(entries).toEqual([
      expect.objectContaining({ kind: "assistant", text: '{"type": "text", "text": "not an event"}' }),
    ]);
  });

  it("starts each run fresh when the parser is reused", () => {
    const parser = createHermesStdoutParser();
    parser.parseLine("┊ review diff", at(0));
    parser.reset();
    expect(parser.parseLine("+not a diff any more", at(1))).toEqual([
      expect.objectContaining({ kind: "assistant", text: "+not a diff any more" }),
    ]);
  });
});
