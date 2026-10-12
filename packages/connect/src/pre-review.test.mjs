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
