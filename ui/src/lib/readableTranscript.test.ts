import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "../adapters";
import {
  buildReadableTranscript,
  formatRunDuration,
  isErrorLikeText,
  stripShellWrapper,
  summarizeToolCall,
  summarizeToolOutcome,
  toolGroupLabel,
} from "./readableTranscript";

const T = (s: number) => `2026-09-30T18:00:${String(s).padStart(2, "0")}.000Z`;

describe("summarizeToolCall", () => {
  it.each([
    ["Read", { file_path: "ui/src/App.tsx" }, "Read", "ui/src/App.tsx"],
    ["Edit", { file_path: "server/src/app.ts", old_string: "a", new_string: "b" }, "Edit", "server/src/app.ts"],
    ["MultiEdit", { file_path: "server/src/app.ts", edits: [] }, "Edit", "server/src/app.ts"],
    ["Write", { file_path: "doc/notes.md", content: "hello" }, "Write", "doc/notes.md"],
    ["NotebookEdit", { notebook_path: "analysis.ipynb", new_source: "x" }, "Edit", "analysis.ipynb"],
    ["Bash", { command: "pnpm test:run", description: "Run tests" }, "Ran", "pnpm test:run"],
    ["Grep", { pattern: "dispatchWebhook", path: "server/src" }, "Searched", "dispatchWebhook"],
    ["Glob", { pattern: "**/*.test.ts" }, "Found files", "**/*.test.ts"],
    ["LS", { path: "ui/src" }, "Listed", "ui/src"],
    ["WebFetch", { url: "https://example.com/docs", prompt: "summarize" }, "Fetched", "https://example.com/docs"],
    ["WebSearch", { query: "vitest jsdom" }, "Searched web", "vitest jsdom"],
    ["Task", { description: "Review the diff", subagent_type: "code-reviewer", prompt: "..." }, "Delegated", "Review the diff"],
    ["TodoWrite", { todos: [{}, {}, {}] }, "Updated plan", "3 items"],
    ["Skill", { skill: "review" }, "Skill", "review"],
  ])("%s → verb + key argument", (name, input, verb, target) => {
    const summary = summarizeToolCall(name, input);
    expect(summary.verb).toBe(verb);
    expect(summary.target).toBe(target);
    expect(summary.label).toBe(`${verb} ${target}`);
  });

  it("labels MCP tools as MCP: tool_name with the key argument", () => {
    const summary = summarizeToolCall("mcp__agentdash__add_issue_comment", { issueId: "AGE-1", body: "hi" });
    expect(summary.verb).toBe("MCP: add_issue_comment");
    expect(summary.target).toBe("AGE-1");
    expect(summarizeToolCall("mcp__github__list_prs", {}).label).toBe("MCP: list_prs");
  });

  it("strips shell wrappers from Codex shell array commands", () => {
    const summary = summarizeToolCall("shell", { command: ["bash", "-lc", "rg -n foo ui/src"] });
    expect(summary).toMatchObject({ verb: "Ran", target: "rg -n foo ui/src", isCommand: true });
  });

  it("strips shell wrappers from command_execution strings", () => {
    expect(summarizeToolCall("command_execution", { command: "/bin/zsh -lc 'pnpm build'" }).target).toBe("pnpm build");
    expect(summarizeToolCall("exec_command", { cmd: "bash -c \"ls -la\"" }).target).toBe("ls -la");
    expect(stripShellWrapper("cmd.exe /d /s /c dir")).toBe("dir");
  });

  it("names the patched file for Codex apply_patch", () => {
    const patch = "*** Begin Patch\n*** Update File: ui/src/App.tsx\n@@\n-a\n+b\n*** End Patch";
    expect(summarizeToolCall("apply_patch", { input: patch }).label).toBe("Patched ui/src/App.tsx");
    expect(summarizeToolCall("apply_patch", patch).target).toBe("ui/src/App.tsx");
    const multi = "*** Begin Patch\n*** Add File: a.ts\n*** Update File: b.ts\n*** Delete File: c.ts\n*** End Patch";
    expect(summarizeToolCall("apply_patch", { patch: multi }).target).toBe("a.ts +2 more");
  });

  it("unwraps the issue chat { value } wrapper for string inputs", () => {
    expect(summarizeToolCall("Bash", { value: "git status" }).label).toBe("Ran git status");
  });

  it("falls back to the humanized tool name and a generic key argument", () => {
    expect(summarizeToolCall("create_issue", { title: "Fix login" }).label).toBe("Create Issue Fix login");
    expect(summarizeToolCall("someCustomTool", {}).label).toBe("Some Custom Tool");
    // Unknown tool that still carries a shell command reads as a command.
    expect(summarizeToolCall("runner", { command: "make test" })).toMatchObject({ verb: "Ran", isCommand: true });
  });

  it("truncates very long targets", () => {
    const summary = summarizeToolCall("Bash", { command: `echo ${"x".repeat(300)}` });
    expect(summary.target!.length).toBeLessThanOrEqual(96);
    expect(summary.target!.endsWith("…")).toBe(true);
  });
});

describe("summarizeToolOutcome", () => {
  it("returns the first line, a structured body line, or a status word", () => {
    expect(summarizeToolOutcome("line one\nline two", "completed")).toBe("line one");
    expect(summarizeToolOutcome("command: ls\nstatus: completed\nexit_code: 0\n\nfile-a\nfile-b", "completed")).toBe("file-a");
    expect(summarizeToolOutcome("", "completed")).toBe("Done");
    expect(summarizeToolOutcome(undefined, "error")).toBe("Failed");
    expect(summarizeToolOutcome(undefined, "running")).toBe("Running…");
  });
});

describe("isErrorLikeText", () => {
  it("keeps error-looking stderr visible and hides noise", () => {
    expect(isErrorLikeText("Error: ECONNREFUSED 127.0.0.1:6379")).toBe(true);
    expect(isErrorLikeText("fatal: not a git repository")).toBe(true);
    expect(isErrorLikeText("Traceback (most recent call last):")).toBe(true);
    expect(isErrorLikeText("npm warn config production Use --omit=dev")).toBe(false);
    expect(isErrorLikeText("Compiled with 0 errors")).toBe(false);
    expect(isErrorLikeText("Downloading model weights")).toBe(false);
  });
});

describe("buildReadableTranscript", () => {
  it("merges streaming assistant deltas into one message block", () => {
    const { blocks } = buildReadableTranscript(
      [
        { kind: "assistant", ts: T(1), text: "Hello", delta: true },
        { kind: "assistant", ts: T(2), text: " world", delta: true },
      ],
      true,
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: "message", text: "Hello world", streaming: true });
  });

  it("folds consecutive tool calls with no assistant text between them", () => {
    const entries: TranscriptEntry[] = [
      { kind: "assistant", ts: T(0), text: "Looking around." },
      { kind: "tool_call", ts: T(1), name: "Grep", toolUseId: "a", input: { pattern: "foo" } },
      { kind: "tool_result", ts: T(2), toolUseId: "a", content: "x.ts:1", isError: false },
      { kind: "thinking", ts: T(3), text: "hmm" },
      { kind: "tool_call", ts: T(4), name: "Read", toolUseId: "b", input: { file_path: "x.ts" } },
      { kind: "tool_result", ts: T(5), toolUseId: "b", content: "body", isError: false },
      { kind: "system", ts: T(6), text: "hook ok" },
      { kind: "tool_call", ts: T(7), name: "Bash", toolUseId: "c", input: { command: "ls" } },
      { kind: "assistant", ts: T(8), text: "Found it." },
      { kind: "tool_call", ts: T(9), name: "Edit", toolUseId: "d", input: { file_path: "x.ts" } },
    ];
    const { blocks } = buildReadableTranscript(entries);
    expect(blocks.map((block) => block.type)).toEqual(["message", "tools", "message", "tools"]);
    const firstGroup = blocks[1];
    expect(firstGroup.type === "tools" && firstGroup.items.map((item) => item.summary.label)).toEqual([
      "Searched foo",
      "Read x.ts",
      "Ran ls",
    ]);
    expect(firstGroup.type === "tools" && firstGroup.items.map((item) => item.status)).toEqual([
      "completed",
      "completed",
      "running",
    ]);
    expect(toolGroupLabel(firstGroup.type === "tools" ? firstGroup.items : [])).toBe("Running 3 tools");
    expect(toolGroupLabel([{ status: "completed" }, { status: "error" }])).toBe("Ran 2 tools");
  });

  it("puts thinking, init, system, non-error stderr and unparsed stdout behind Details", () => {
    const { blocks, details } = buildReadableTranscript([
      { kind: "init", ts: T(0), model: "claude", sessionId: "s1" },
      { kind: "system", ts: T(1), text: "turn started" },
      { kind: "system", ts: T(1), text: "hook PreToolUse allowed" },
      { kind: "thinking", ts: T(2), text: "Plan the change" },
      { kind: "stderr", ts: T(3), text: "npm warn deprecated glob" },
      { kind: "stdout", ts: T(4), text: "some unparsed line" },
      { kind: "assistant", ts: T(5), text: "Done" },
    ]);
    expect(blocks).toHaveLength(1);
    expect(details.map((line) => line.kind)).toEqual(["init", "system", "thinking", "stderr", "stdout"]);
  });

  it("keeps errors visible: failed tool results and error-looking stderr", () => {
    const { blocks, details } = buildReadableTranscript([
      { kind: "tool_call", ts: T(0), name: "Bash", toolUseId: "a", input: { command: "pnpm test" } },
      { kind: "tool_result", ts: T(1), toolUseId: "a", content: "FAIL x.test.ts", isError: true },
      { kind: "stderr", ts: T(2), text: "Error: ENOENT: no such file" },
      { kind: "stderr", ts: T(2), text: "fatal: bad revision" },
    ]);
    expect(blocks[0]).toMatchObject({ type: "tools", items: [{ status: "error", result: "FAIL x.test.ts" }] });
    expect(blocks[1]).toMatchObject({ type: "error", lines: ["Error: ENOENT: no such file", "fatal: bad revision"] });
    expect(details).toHaveLength(0);
  });

  it("hides the saved-session resume notice entirely", () => {
    const { blocks, details } = buildReadableTranscript([
      { kind: "stderr", ts: T(0), text: "[paperclip] Skipping saved session resume for task \"PAP-1\" because wake reason is issue_assigned." },
    ]);
    expect(blocks).toHaveLength(0);
    expect(details).toHaveLength(0);
  });

  it("streams stdout into the running command instead of Details", () => {
    const { blocks, details } = buildReadableTranscript([
      { kind: "tool_call", ts: T(0), name: "command_execution", toolUseId: "c1", input: { command: "ls -la" } },
      { kind: "stdout", ts: T(1), text: "file-a\nfile-b" },
    ]);
    expect(details).toHaveLength(0);
    expect(blocks[0]).toMatchObject({ type: "tools", items: [{ status: "running", result: "file-a\nfile-b" }] });
  });

  it("builds a compact result footer with duration, tokens and cost", () => {
    const { footer } = buildReadableTranscript([
      { kind: "init", ts: T(0), model: "claude", sessionId: "s" },
      { kind: "assistant", ts: T(10), text: "All done." },
      {
        kind: "result",
        ts: "2026-09-30T18:02:14.000Z",
        text: "All done.",
        inputTokens: 12000,
        outputTokens: 800,
        cachedTokens: 0,
        costUsd: 0.05,
        subtype: "success",
        isError: false,
        errors: [],
      },
    ]);
    expect(footer).toMatchObject({ outcome: "Completed", isError: false, durationMs: 134000, inputTokens: 12000 });
    // Result text that repeats the final assistant message is not shown twice.
    expect(footer?.text).toBeNull();
    expect(formatRunDuration(134000)).toBe("2m 14s");
    expect(formatRunDuration(5000)).toBe("5s");
    expect(formatRunDuration(3_720_000)).toBe("1h 2m");
  });
});
