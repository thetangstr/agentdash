import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createInboxMcpHandler } from "./inbox-mcp.mjs";
import {
  DENIED_BUILTIN_TOOLS,
  READ_ONLY_BUILTIN_TOOLS,
  READ_ONLY_INBOX_TOOLS,
  REVIEW_MARKER,
  WRITE_INBOX_TOOLS,
  buildPreReviewCommand,
  claudeFeaturesFromHelp,
  preReviewAllowedTools,
  preReviewDeniedTools,
  preReviewPrompt,
  runPreReview,
  workFolderName,
  writeReviewFile,
} from "./pre-review.mjs";

const SERVER = "http://agentdash.example.test:3100";

/** The option lines of a current `claude --help`, as checked locally (Claude Code 2.1.x). */
const CURRENT_HELP = `
Options:
  --allowedTools, --allowed-tools <tools...>  Comma or space-separated list of tool names to allow
  --append-system-prompt <prompt>       Append a system prompt to the default system prompt
  --disallowedTools, --disallowed-tools <tools...>  Comma or space-separated list of tool names to deny
  --mcp-config <configs...>             Load MCP servers from JSON files or strings
  --no-session-persistence              Disable session persistence
  --output-format <format>              Output format (only works with --print)
  --permission-mode <mode>              Permission mode to use for the session (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")
  --permission-prompts <target>         Who answers permission prompts with --print
  -p, --print                           Print response and exit (useful for pipes).
  --restricted                          Restricted mode
  --settings <file-or-json>             Path to a settings JSON file or a JSON string
  --strict-mcp-config                   Only use MCP servers from --mcp-config
  --tools <tools...>                    Specify the list of available tools from the built-in set.
`;

/**
 * An excerpt of a real `claude --help` (Claude Code 2.1.x), wrapped the way the
 * CLI wraps it: descriptions continue on deeper-indented lines, and several of
 * those continuation lines begin with another flag's name.
 */
const REAL_HELP = [
  "Usage: claude [options] [command] [prompt]",
  "",
  "Options:",
  "  --allowedTools, --allowed-tools <tools...>",
  "      Comma or space-separated list of tool names to allow (e.g. \"Bash(git *)",
  "      Edit\")",
  "  --append-system-prompt <prompt>       Append a system prompt to the default",
  "                                        system prompt",
  "  --bare                                Minimal mode: skip hooks. Explicitly provide context",
  "                                        via: --system-prompt[-file],",
  "                                        --append-system-prompt[-file], --add-dir",
  "                                        (CLAUDE.md dirs), --mcp-config,",
  "                                        --settings, --agents, --plugin-dir.",
  "  --disallowedTools, --disallowed-tools <tools...>",
  "      Comma or space-separated list of tool names to deny (e.g. \"Bash(git *)",
  "      Edit\")",
  "  --forward-subagent-text               Forward subagent text and thinking",
  "                                        blocks as assistant/user messages (only works with",
  "                                        --print and --output-format=stream-json)",
  "  -h, --help                            Display help for command",
  "  --mcp-config <configs...>             Load MCP servers from JSON files or",
  "                                        strings (space-separated)",
  "  --no-session-persistence              Disable session persistence - sessions",
  "                                        will not be saved to disk and cannot be",
  "                                        resumed (only works with --print)",
  "  --output-format <format>              Output format (only works with --print):",
  "                                        \"text\" (default), \"json\" (single",
  "                                        result), or \"stream-json\" (realtime",
  "                                        streaming) (choices: \"text\", \"json\",",
  "                                        \"stream-json\")",
  "  --permission-mode <mode>              Permission mode to use for the session",
  "                                        (choices: \"acceptEdits\", \"auto\",",
  "                                        \"bypassPermissions\", \"manual\",",
  "                                        \"dontAsk\", \"plan\")",
  "  --permission-prompts <target>         Who answers permission prompts with",
  "                                        --print: \"host\" (the SDK host or",
  "                                        --permission-prompt-tool) or \"none\"",
  "  -p, --print                           Print response and exit (useful for",
  "                                        pipes).",
  "  --restricted                          Restricted mode: removes the built-in",
  "                                        tools that run commands or code (Bash,",
  "                                        PowerShell, REPL and the other",
  "                                        code-running tools) and WebFetch unless",
  "                                        --tools names them, and ignores user,",
  "                                        project and local settings files",
  "                                        (managed settings and --settings still",
  "                                        apply; add --strict-mcp-config to skip",
  "                                        MCP servers too).",
  "  --settings <file-or-json>             Path to a settings JSON file or a JSON",
  "                                        string to load additional settings from",
  "  --strict-mcp-config                   Only use MCP servers from --mcp-config,",
  "                                        ignoring all other MCP configurations",
  "  --system-prompt-snapshot <on|off>     Record the system prompt once per",
  "                                        conversation: a",
  "                                        --system-prompt or",
  "                                        --append-system-prompt included.",
  "  --tools <tools...>                    Specify the list of available tools from",
  "                                        the built-in set. Use \"\" to disable all",
  "                                        tools.",
  "",
  "Commands:",
  "  agents [options]                      List and manage background sessions",
].join("\n");

const tmpDirs = [];
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "connect-prereview-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const LAUNCH = { command: "/opt/node/bin/node", args: ["/home/person-a/.agentdash/connect-runtime/bin/agentdash-connect.mjs"] };

function command(overrides = {}) {
  return buildPreReviewCommand({
    claudePath: "/home/person-a/.local/bin/claude",
    inboxDir: "/home/person-a/agentdash-inbox",
    issueId: "3f1c9a52-0000-4000-8000-000000000041",
    identifier: "ACME-41",
    server: SERVER,
    skillText: "---\nname: agentdash-coworker\n---\n# AgentDash co-worker\nReview rules.",
    mcpLaunch: LAUNCH,
    features: claudeFeaturesFromHelp(CURRENT_HELP),
    env: { PATH: "/usr/bin", HOME: "/home/person-a" },
    ...overrides,
  });
}

const valueOf = (args, flag) => args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);

describe("the pre-review's tool allowlist", () => {
  it("allows only tools that read, and denies every tool that writes", () => {
    const allowed = preReviewAllowedTools();
    const denied = preReviewDeniedTools();
    expect(allowed).toEqual([
      "Read",
      "Grep",
      "Glob",
      "mcp__agentdash-inbox__inbox_sync",
      "mcp__agentdash-inbox__inbox_agents",
      "mcp__agentdash-inbox__work_list",
      "mcp__agentdash-inbox__work_read",
      "mcp__agentdash-inbox__work_run_log",
      "mcp__agentdash-inbox__work_fetch_file",
      "mcp__agentdash-inbox__work_read_file_text",
    ]);
    for (const tool of WRITE_INBOX_TOOLS) {
      expect(denied).toContain(`mcp__agentdash-inbox__${tool}`);
      expect(allowed).not.toContain(`mcp__agentdash-inbox__${tool}`);
    }
    for (const tool of ["Bash", "Write", "Edit", "WebFetch", "WebSearch"]) {
      expect(denied).toContain(tool);
      expect(allowed).not.toContain(tool);
    }
    expect(allowed.filter((tool) => denied.includes(tool))).toEqual([]);
  });

  /**
   * A new inbox tool must be classified on purpose. Unclassified, it would be
   * neither allowed nor denied by name; this fails first.
   */
  it("classifies every inbox tool the MCP server lists as read-only or write", async () => {
    const handle = createInboxMcpHandler({}, { readServer: () => SERVER, readToken: () => "t", owner: null });
    const list = await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = list.result.tools.map((tool) => tool.name);
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) {
      expect([...READ_ONLY_INBOX_TOOLS, ...WRITE_INBOX_TOOLS]).toContain(name);
    }
    expect(READ_ONLY_INBOX_TOOLS.filter((name) => WRITE_INBOX_TOOLS.includes(name))).toEqual([]);
  });
});

describe("buildPreReviewCommand", () => {
  it("runs Claude Code headless, read-only, with the inbox tools served read-only", () => {
    const cmd = command();
    expect(cmd.command).toBe("/home/person-a/.local/bin/claude");
    expect(cmd.cwd).toBe("/home/person-a/agentdash-inbox");
    expect(cmd.args[0]).toBe("--print");
    expect(cmd.args).toContain("--output-format=text");
    expect(cmd.args).toContain("--permission-mode=dontAsk");
    expect(valueOf(cmd.args, "--tools")).toBe(READ_ONLY_BUILTIN_TOOLS.join(","));
    expect(valueOf(cmd.args, "--allowedTools")).toBe(preReviewAllowedTools().join(","));
    expect(valueOf(cmd.args, "--disallowedTools")).toBe(preReviewDeniedTools().join(","));
    expect(cmd.args).toContain("--strict-mcp-config");
    expect(cmd.args).toContain("--restricted");
    expect(cmd.args).toContain("--no-session-persistence");
    expect(cmd.args).toContain("--permission-prompts=none");
    expect(JSON.parse(valueOf(cmd.args, "--settings"))).toEqual({ disableAllHooks: true });

    const mcp = JSON.parse(valueOf(cmd.args, "--mcp-config"));
    expect(Object.keys(mcp.mcpServers)).toEqual(["agentdash-inbox"]);
    const inbox = mcp.mcpServers["agentdash-inbox"];
    // This package's own copy, with node: no npx, so no registry call.
    expect(inbox.command).toBe("/opt/node/bin/node");
    expect(inbox.args).toEqual([...LAUNCH.args, "mcp", "--read-only", "--server", SERVER]);

    expect(cmd.env.AGENTDASH_PRE_REVIEW).toBe("1");
    expect(cmd.env.PATH.split(":")).toEqual(expect.arrayContaining(["/home/person-a/.local/bin", "/opt/node/bin", "/usr/bin"]));
  });

  it("never loosens permissions", () => {
    const joined = command().args.join("\n");
    expect(joined).not.toMatch(/dangerously|bypassPermissions|acceptEdits|--permission-mode=auto/);
    // Every option that takes values is in --flag=value form, so none can swallow another.
    for (const arg of command().args) expect(arg.startsWith("--")).toBe(true);
  });

  it("puts nothing an agent wrote in the prompt, and strips the skill's frontmatter", () => {
    const cmd = command();
    expect(cmd.input).toBe(preReviewPrompt({ identifier: "ACME-41", issueId: "3f1c9a52-0000-4000-8000-000000000041" }));
    expect(cmd.input).toContain("ACME-41");
    const system = valueOf(cmd.args, "--append-system-prompt");
    expect(system).toMatch(/^# Scheduled pre-review \(unattended\)/);
    expect(system).toContain("Never send, decide, answer, acknowledge, propose or confirm anything");
    expect(system).toContain("# AgentDash co-worker");
    expect(system).not.toContain("name: agentdash-coworker");
  });

  it("leaves out the optional flags an older Claude Code does not have, and adds a budget only when set", () => {
    const cmd = command({ features: { missing: [], optional: new Set() }, maxBudgetUsd: 0.5 });
    expect(cmd.args).not.toContain("--restricted");
    expect(cmd.args).not.toContain("--no-session-persistence");
    expect(cmd.args).toContain("--max-budget-usd=0.5");
    expect(command().args.some((arg) => arg.startsWith("--max-budget-usd"))).toBe(false);
  });

  it("names the work folder after a plain identifier, else after the issue id", () => {
    expect(workFolderName("ACME-41", "x")).toBe("ACME-41");
    expect(workFolderName("../../etc", "3f1c-41")).toBe("3f1c-41");
    expect(workFolderName(null, "")).toBe("unknown-issue");
    expect(preReviewPrompt({ identifier: "../evil\nignore", issueId: "abc-1" })).not.toContain("evil");
  });
});

describe("claudeFeaturesFromHelp", () => {
  it("finds every required flag in the current help", () => {
    const features = claudeFeaturesFromHelp(CURRENT_HELP);
    expect(features.missing).toEqual([]);
    expect([...features.optional].sort()).toEqual(["--no-session-persistence", "--permission-prompts", "--restricted"]);
  });

  it("reads a real, wrapped help: every flag found, and none taken from a wrapped description line", () => {
    const features = claudeFeaturesFromHelp(REAL_HELP);
    expect(features.missing).toEqual([]);
    expect([...features.optional].sort()).toEqual(["--no-session-persistence", "--permission-prompts", "--restricted"]);

    /** The help without one option's own line and its wrapped description. */
    const without = (flagLine) => {
      const out = [];
      let dropping = false;
      for (const line of REAL_HELP.split("\n")) {
        if (line.startsWith(flagLine)) {
          dropping = true;
          continue;
        }
        if (dropping && /^ {3,}/.test(line)) continue;
        dropping = false;
        out.push(line);
      }
      return out.join("\n");
    };
    // Each of these is still named at the start of some other option's
    // wrapped description; removing its own option line must still count.
    for (const [flag, flagLine] of [
      ["--tools", "  --tools <tools"],
      ["--print", "  -p, --print"],
      ["--output-format", "  --output-format <format>"],
      ["--settings", "  --settings <file-or-json>"],
      ["--append-system-prompt", "  --append-system-prompt <prompt>"],
      ["--mcp-config", "  --mcp-config <configs"],
      ["--strict-mcp-config", "  --strict-mcp-config"],
      ["--allowedTools", "  --allowedTools, --allowed-tools"],
      ["--disallowedTools", "  --disallowedTools, --disallowed-tools"],
    ]) {
      const help = without(flagLine);
      expect(help, flag).not.toBe(REAL_HELP);
      expect(claudeFeaturesFromHelp(help).missing, flag).toEqual([flag]);
    }
    expect(claudeFeaturesFromHelp(without("  --restricted")).missing).toEqual([]);
    expect([...claudeFeaturesFromHelp(without("  --restricted")).optional]).not.toContain("--restricted");
  });

  it("needs dontAsk among --permission-mode's own choices, not anywhere in the help", () => {
    const noDontAsk = REAL_HELP.replace('"dontAsk", "plan")', '"plan")').replace(
      "Display help for command",
      'Display help for command (see "dontAsk" in the docs)',
    );
    expect(noDontAsk).toContain("dontAsk");
    expect(claudeFeaturesFromHelp(noDontAsk).missing).toEqual(['--permission-mode "dontAsk"']);
  });

  it("reports what an older Claude Code lacks", () => {
    const older = CURRENT_HELP.split("\n")
      .filter((line) => !line.includes("--tools <tools") && !line.includes("--permission-mode"))
      .join("\n");
    const features = claudeFeaturesFromHelp(older);
    expect(features.missing).toEqual(expect.arrayContaining(["--tools", "--permission-mode", '--permission-mode "dontAsk"']));
  });
});

describe("runPreReview", () => {
  function ctx(inboxDir, extra = {}) {
    return {
      claudePath: "/home/person-a/.local/bin/claude",
      inboxDir,
      server: SERVER,
      mcpLaunch: LAUNCH,
      readSkill: () => "# skill",
      ...extra,
    };
  }
  const item = { issueId: "3f1c9a52-0000-4000-8000-000000000041", identifier: "ACME-41" };
  const fixed = () => new Date("2026-10-12T09:00:00.000Z");

  it("writes Claude's answer to work/<ISSUE>/review.md, private, under a header that says what it is", () => {
    const inboxDir = tmp();
    const calls = [];
    const run = (cmd, args, options) => {
      calls.push({ cmd, args, options });
      if (args[0] === "--help") return { status: 0, stdout: CURRENT_HELP, stderr: "" };
      return { status: 0, stdout: "## ACME-41\n\nMy take: send it.\n", stderr: "" };
    };
    const result = runPreReview(item, ctx(inboxDir), { run, now: fixed });
    expect(result.ok).toBe(true);
    const file = path.join(inboxDir, "work", "ACME-41", "review.md");
    expect(result.path).toBe(file);
    const text = fs.readFileSync(file, "utf8");
    expect(text.startsWith(REVIEW_MARKER)).toBe(true);
    expect(text).toContain("Prepared unattended at 2026-10-12T09:00:00.000Z");
    expect(text).toContain("Nothing was sent.");
    expect(text).toContain("My take: send it.");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);

    // The review itself ran in the inbox folder, prompt on stdin, read-only.
    const review = calls[1];
    expect(review.options.cwd).toBe(inboxDir);
    expect(review.options.input).toContain("ACME-41");
    expect(review.args).toContain("--permission-mode=dontAsk");
  });

  it("runs nothing when the installed Claude Code cannot enforce read-only", () => {
    const calls = [];
    const run = (cmd, args) => {
      calls.push(args);
      return { status: 0, stdout: "  -p, --print   Print response and exit\n", stderr: "" };
    };
    const result = runPreReview(item, ctx(tmp()), { run, now: fixed });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/cannot run a read-only pre-review/);
    expect(calls).toEqual([["--help"]]);
  });

  /**
   * `--restricted` is optional: without it the run is still read-only because
   * the tool set, the exact allow and deny lists and the strict read-only MCP
   * config are required. Losing any ONE of those stops the run before claude
   * is ever started for a review.
   */
  it("refuses when any one of the read-only enforcing flags is missing, but runs without --restricted", () => {
    const enforcing = {
      "--tools": "--tools <tools",
      "--allowedTools": "--allowedTools, --allowed-tools",
      "--disallowedTools": "--disallowedTools, --disallowed-tools",
      "--strict-mcp-config": "--strict-mcp-config",
      "--mcp-config": "--mcp-config <configs",
    };
    for (const [flag, lineStart] of Object.entries(enforcing)) {
      const help = CURRENT_HELP.split("\n").filter((line) => !line.trimStart().startsWith(lineStart)).join("\n");
      expect(help, flag).not.toBe(CURRENT_HELP);
      expect(claudeFeaturesFromHelp(help).missing, flag).toEqual([flag]);
      const calls = [];
      const run = (_cmd, args) => {
        calls.push(args);
        return { status: 0, stdout: help, stderr: "" };
      };
      const result = runPreReview(item, ctx(tmp()), { run, now: fixed });
      expect(result.ok, flag).toBe(false);
      expect(result.reason, flag).toContain(`missing ${flag}`);
      expect(calls, flag).toEqual([["--help"]]);
    }

    const noRestricted = CURRENT_HELP.split("\n").filter((line) => !line.includes("--restricted")).join("\n");
    const calls = [];
    const run = (_cmd, args) => {
      calls.push(args);
      if (args[0] === "--help") return { status: 0, stdout: noRestricted, stderr: "" };
      return { status: 0, stdout: "## ACME-41\n\nLooks fine.\n", stderr: "" };
    };
    const result = runPreReview(item, ctx(tmp()), { run, now: fixed });
    expect(result.ok).toBe(true);
    const review = calls[1];
    expect(review).not.toContain("--restricted");
    expect(review).toContain("--strict-mcp-config");
    expect(valueOf(review, "--tools")).toBe("Read,Grep,Glob");
    expect(valueOf(review, "--allowedTools")).toBe(preReviewAllowedTools().join(","));
    expect(valueOf(review, "--disallowedTools")).toBe(preReviewDeniedTools().join(","));
  });

  it("writes nothing when claude fails, returns nothing, or is missing", () => {
    const inboxDir = tmp();
    const features = claudeFeaturesFromHelp(CURRENT_HELP);
    const failing = () => ({ status: 1, stdout: "", stderr: "boom\nrate limited" });
    expect(runPreReview(item, ctx(inboxDir, { features }), { run: failing, now: fixed })).toMatchObject({
      ok: false,
      reason: "claude exited 1: rate limited",
    });
    const empty = () => ({ status: 0, stdout: "  \n", stderr: "" });
    expect(runPreReview(item, ctx(inboxDir, { features }), { run: empty, now: fixed }).ok).toBe(false);
    const timedOut = () => ({ status: null, error: Object.assign(new Error("spawnSync claude ETIMEDOUT"), { code: "ETIMEDOUT" }) });
    expect(runPreReview(item, ctx(inboxDir, { features }), { run: timedOut, now: fixed }).reason).toMatch(/ETIMEDOUT/);
    expect(runPreReview(item, ctx(inboxDir, { claudePath: null }), { run: failing, now: fixed }).reason).toMatch(/not found/);
    expect(fs.existsSync(path.join(inboxDir, "work"))).toBe(false);
  });

  it("replaces its own earlier review.md but never the person's own file", () => {
    const inboxDir = tmp();
    const first = writeReviewFile(inboxDir, { identifier: "ACME-41", issueId: "x", text: "old take", preparedAt: "t1" });
    expect(first.path).not.toBeNull();
    const second = writeReviewFile(inboxDir, { identifier: "ACME-41", issueId: "x", text: "new take", preparedAt: "t2" });
    expect(fs.readFileSync(second.path, "utf8")).toContain("new take");

    fs.writeFileSync(second.path, "my own notes");
    const kept = writeReviewFile(inboxDir, { identifier: "ACME-41", issueId: "x", text: "newer", preparedAt: "t3" });
    expect(kept.path).toBeNull();
    expect(kept.reason).toMatch(/kept your own/);
    expect(fs.readFileSync(second.path, "utf8")).toBe("my own notes");
  });

  it("lists the built-in tools it denies by name", () => {
    expect(DENIED_BUILTIN_TOOLS).toEqual(expect.arrayContaining(["Bash", "Write", "Edit", "WebFetch"]));
  });
});
