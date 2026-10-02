import { describe, expect, it, vi } from "vitest";
import type { TranscriptEntry } from "../adapters";
import {
  ReadableTranscriptBuilder,
  buildReadableTranscript,
  commandLabel,
  updateReadableTranscript,
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

describe("commandLabel (multi-line scripts)", () => {
  it("leaves a single command alone", () => {
    expect(commandLabel("pnpm test:run")).toBe("pnpm test:run");
    expect(commandLabel("FOO=1 pnpm build")).toBe("FOO=1 pnpm build");
    expect(commandLabel("cd ui")).toBe("cd ui");
  });

  it("skips set -e, assignments, cd and comments to the first real command", () => {
    const script = [
      "set -euo pipefail",
      "# where the box lives",
      'BASE="http://127.0.0.1:3100"',
      "TOKEN=$(cat ~/.token)",
      "export NODE_ENV=production",
      "cd /srv/app",
      'curl -s "$BASE/api/health" | jq .status',
    ].join("\n");
    expect(commandLabel(script)).toBe('curl -s "$BASE/api/health" | jq .status');
  });

  it("prefers an echo heading anywhere in the script", () => {
    const script = [
      "set -e",
      "BASE=/tmp/x",
      "ls $BASE",
      'echo "=== Checking migrations ==="',
      "pnpm db:migrate",
    ].join("\n");
    expect(commandLabel(script)).toBe("script: Checking migrations");
    expect(commandLabel("set -e\necho '--- Build UI ---'\npnpm build")).toBe("script: Build UI");
    expect(commandLabel("set -e; echo \"### Typecheck\"; pnpm -r typecheck")).toBe("script: Typecheck");
  });

  it("marks a heading as the script's name, never as the command that ran", () => {
    const script = 'echo "=== Run tests ==="\nrm -rf ~/data';
    const summary = summarizeToolCall("Bash", { command: script });
    expect(summary.label).toBe("Ran script: Run tests");
    expect(summary.script).toBe(script);
  });

  it("does not treat a plain echo as a heading", () => {
    expect(commandLabel("set -e\necho done\npnpm build")).toBe("echo done");
  });

  it("splits && and ; outside quotes but not inside them", () => {
    expect(commandLabel("set -e && cd ui && pnpm vitest run")).toBe("pnpm vitest run");
    expect(commandLabel("cd ui; grep -n 'a;b && c' file.ts")).toBe("grep -n 'a;b && c' file.ts");
  });

  it("falls back to the first statement when everything is set-up", () => {
    expect(commandLabel("set -e\nBASE=1\ncd /tmp")).toBe("set -e");
  });

  it("labels a Bash call by its first real command and keeps the whole script", () => {
    const script = "set -e\nBASE=https://example.test\ncurl -s $BASE/health";
    const summary = summarizeToolCall("Bash", { command: script });
    expect(summary.label).toBe("Ran curl -s $BASE/health");
    expect(summary.isCommand).toBe(true);
    expect(summary.script).toBe(script);
  });

  it("unwraps shell wrappers before labelling", () => {
    const summary = summarizeToolCall("shell", { command: ["bash", "-lc", "set -e\ncd repo\ngit status"] });
    expect(summary.target).toBe("git status");
    expect(summary.script).toBe("set -e\ncd repo\ngit status");
  });

  it("carries no script when the label already is the command", () => {
    expect(summarizeToolCall("Bash", { command: "git status" }).script).toBeUndefined();
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
    const { blocks } = buildReadableTranscript(entries, true);
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
    ], true);
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

describe("closing and matching tool calls", () => {
  const call = (id: string | undefined, name = "Read", s = 1): TranscriptEntry => ({
    kind: "tool_call",
    ts: T(s),
    name,
    toolUseId: id,
    input: { file_path: `${id ?? "anon"}.ts`, command: "ls" },
  });
  const result = (id: string, content: string, s = 2): TranscriptEntry => ({
    kind: "tool_result",
    ts: T(s),
    toolUseId: id,
    content,
    isError: false,
  });
  const resultEntry: TranscriptEntry = {
    kind: "result",
    ts: T(30),
    text: "",
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
    subtype: "success",
    isError: false,
    errors: [],
  };
  const toolItems = (entries: TranscriptEntry[], streaming = true) => {
    const block = buildReadableTranscript(entries, streaming).blocks[0];
    return block?.type === "tools" ? block.items : [];
  };

  it("closes still-running calls as no_result once the run has a result entry", () => {
    const items = toolItems([call("a"), call("b"), result("a", "ok"), resultEntry]);
    expect(items.map((item) => item.status)).toEqual(["completed", "no_result"]);
    expect(toolGroupLabel(items)).toBe("Ran 2 tools");
    expect(summarizeToolOutcome(undefined, "no_result")).toBe("No result");
  });

  it("closes still-running calls when the run is no longer streaming, keeps them running while it is", () => {
    expect(toolItems([call("a")], true)[0].status).toBe("running");
    expect(toolItems([call("a")], false)[0].status).toBe("no_result");
  });

  it("matches results by exact toolUseId even when they arrive out of order", () => {
    const items = toolItems([call("a"), call("b"), result("b", "B out"), result("a", "A out")]);
    expect(items.map((item) => item.result)).toEqual(["A out", "B out"]);
  });

  it("falls back only to the most recent call without a result and without its own id", () => {
    const items = toolItems([
      call(undefined, "Read", 1),
      call("b", "Read", 2),
      // An id-less result must not take b's slot; it goes to the id-less call.
      { kind: "tool_result", ts: T(3), toolUseId: "", content: "anon out", isError: false },
      result("b", "B out", 4),
    ]);
    expect(items.map((item) => [item.summary.target, item.result])).toEqual([
      ["anon.ts", "anon out"],
      ["b.ts", "B out"],
    ]);
  });

  it("does not attach later stdout to an earlier command once another call has started", () => {
    const { blocks, details } = buildReadableTranscript(
      [call("cmd", "Bash", 1), call("r", "Read", 2), { kind: "stdout", ts: T(3), text: "late output" }],
      true,
    );
    const items = blocks[0].type === "tools" ? blocks[0].items : [];
    expect(items[0].result).toBeUndefined();
    expect(details).toEqual([expect.objectContaining({ kind: "stdout", text: "late output" })]);
  });

  it("does not attach stdout to a command whose result already arrived", () => {
    const { blocks, details } = buildReadableTranscript(
      [call("cmd", "Bash", 1), result("cmd", "done"), { kind: "stdout", ts: T(3), text: "after" }],
      true,
    );
    expect(blocks[0]).toMatchObject({ items: [{ result: "done" }] });
    expect(details.map((line) => line.text)).toEqual(["after"]);
  });
});

describe("incremental building", () => {
  const entries: TranscriptEntry[] = [
    { kind: "assistant", ts: T(0), text: "Start" },
    { kind: "tool_call", ts: T(1), name: "Grep", toolUseId: "g", input: { pattern: "x" } },
    { kind: "tool_result", ts: T(2), toolUseId: "g", content: "hit", isError: false },
    { kind: "assistant", ts: T(3), text: "Done" },
  ];

  it("extends the cached builder with only the new entries", () => {
    const first = updateReadableTranscript(null, entries.slice(0, 2), true);
    const pushSpy = vi.spyOn(ReadableTranscriptBuilder.prototype, "push");
    // Fresh objects with the same content, as the live hooks produce on each poll.
    const next = updateReadableTranscript(first.cache, entries.map((entry) => ({ ...entry })), true);
    expect(pushSpy).toHaveBeenCalledTimes(2);
    pushSpy.mockRestore();
    expect(next.cache.builder).toBe(first.cache.builder);
    expect(next.transcript).toEqual(buildReadableTranscript(entries, true));
  });

  it("rebuilds when an earlier entry changed (for example a grown delta)", () => {
    const first = updateReadableTranscript(null, entries.slice(0, 1), true);
    const changed: TranscriptEntry[] = [{ kind: "assistant", ts: T(0), text: "Start, then more" }, ...entries.slice(1)];
    const next = updateReadableTranscript(first.cache, changed, true);
    expect(next.cache.builder).not.toBe(first.cache.builder);
    expect(next.transcript).toEqual(buildReadableTranscript(changed, true));
  });

  it("rebuilds when streaming flips", () => {
    const first = updateReadableTranscript(null, entries, true);
    const next = updateReadableTranscript(first.cache, entries, false);
    expect(next.cache.builder).not.toBe(first.cache.builder);
  });
});
