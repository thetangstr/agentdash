import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptEntry } from "../adapters";
import {
  ReadableTranscriptBuilder,
  buildReadableTranscript,
  commandLabel,
  commandName,
  parseAgentDashApiCall,
  redactSecrets,
  scriptEnv,
  shellWords,
  updateReadableTranscript,
  formatRunDuration,
  heredocWriteTarget,
  summarizeJsonOutput,
  isErrorLikeText,
  stripShellWrapper,
  summarizeToolCall,
  summarizeToolOutcome,
  toolGroupLabel,
} from "./readableTranscript";
import { redactSecretsInValue } from "./redactSecrets";

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
    const summary = summarizeToolCall("Grep", { pattern: "x".repeat(300) });
    expect(summary.target!.length).toBeLessThanOrEqual(96);
    expect(summary.target!.endsWith("…")).toBe(true);
  });

  it("names a long single command by its program, keeping the full command one click away", () => {
    const command = `echo ${"x".repeat(300)}`;
    const summary = summarizeToolCall("Bash", { command });
    expect(summary.label).toBe("Ran echo");
    expect(summary.script).toBe(command);
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

// AgentDash (scan 4 lane O1): the Readable transcript showed raw single
// commands such as `curl -s "http://127.0.0.1:3489/api/issues/<uuid>" -H
// "Authorizati…`. They now read as what they did, and never carry a credential.
// Cases ported from the PR #990 review probes.
describe("single commands (scan 4 lane O1)", () => {
  const ISSUE_UUID = "9eaca194-0091-4e45-a12a-e5bc9bc79a44";
  const AUTH = '-H "Authorization: Bearer $PAPERCLIP_API_KEY"';

  beforeEach(() => {
    // The UI is served from the instance; its origin is the API base.
    vi.stubGlobal("window", { location: { host: "127.0.0.1:3489", hostname: "127.0.0.1" } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads a curl to the AgentDash API as the action it took", () => {
    const read = summarizeToolCall("Bash", { command: `curl -s "http://127.0.0.1:3489/api/issues/${ISSUE_UUID}" ${AUTH}` });
    expect(read).toMatchObject({ verb: "Read issue", target: null, label: "Read issue", isCommand: true });

    const update = summarizeToolCall("Bash", {
      command: `curl -s -X PATCH "$PAPERCLIP_API_URL/api/issues/WHI-1" ${AUTH} -H "Content-Type: application/json" -d '{"status":"in_review"}'`,
    });
    expect(update.label).toBe("Updated issue WHI-1");

    const comment = summarizeToolCall("Bash", {
      command: `curl -s "$PAPERCLIP_API_URL/api/issues/$PAPERCLIP_TASK_ID/comments" ${AUTH} --data-raw '{"body":"done"}'`,
    });
    expect(comment.label).toBe("Commented on issue");

    const doc = summarizeToolCall("Bash", {
      command: `curl -s "\${PAPERCLIP_API_URL}/api/issues/WHI-1/documents/checklist" -X PUT ${AUTH} -d @b.json`,
    });
    expect(doc.label).toBe("Saved a document on issue WHI-1");

    expect(summarizeToolCall("Bash", { command: `curl -s "$PAPERCLIP_API_URL/api/agents/me" ${AUTH} | jq .name` }).label)
      .toBe("Checked its own profile");
  });

  it("falls back to Called AgentDash: METHOD route template for routes without a phrase", () => {
    const summary = summarizeToolCall("Bash", {
      command: `curl -s -XPOST "http://127.0.0.1:3489/api/issues/${ISSUE_UUID}/feedback-votes?x=1" ${AUTH} -d '{}'`,
    });
    expect(summary.verb).toBe("Called AgentDash:");
    expect(summary.target).toBe("POST /api/issues/:id/feedback-votes");
    expect(summarizeToolCall("Bash", { command: `curl -s -X DELETE "$PAPERCLIP_API_URL/api/issues/WHI-1" ${AUTH}` }).label)
      .toBe("Called AgentDash: DELETE /api/issues/:id");
    expect(summarizeToolCall("Bash", { command: `curl -s -X patch "$PAPERCLIP_API_URL/api/issues/WHI-1" -d '{}'` }).label)
      .toBe("Updated issue WHI-1");
  });

  it("parses method, route template and issue key", () => {
    expect(parseAgentDashApiCall(`curl "$PAPERCLIP_API_URL/api/companies/${ISSUE_UUID}/issues" -d '{}'`)).toEqual({
      method: "POST",
      route: "/api/companies/:companyId/issues",
      issueRef: null,
      action: "Created an issue",
    });
    expect(parseAgentDashApiCall(`curl "$AGENTDASH_API_URL/api/issues/WHI-12"`)?.issueRef).toBe("WHI-12");
    expect(parseAgentDashApiCall(`curl -s "$PAPERCLIP_API_URL/api/issues/WHI-1/documents/checklist/revisions"`)?.route)
      .toBe("/api/issues/:id/documents/:key/revisions");
    expect(parseAgentDashApiCall(`curl -s "$PAPERCLIP_API_URL/api/issues/WHI-1/comments?after=x"`)?.action)
      .toBe("Read the comments on issue");
    expect(parseAgentDashApiCall("git status")).toBeNull();
  });

  it("-G / --get is a GET, -T is a PUT, -I is a HEAD", () => {
    expect(parseAgentDashApiCall(`curl -s -G "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues" --data-urlencode "q=x"`)?.action)
      .toBe("Listed issues");
    expect(parseAgentDashApiCall(`curl -s --get "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues" -d "status=todo"`)?.method)
      .toBe("GET");
    expect(parseAgentDashApiCall(`curl -s -T file.json "$PAPERCLIP_API_URL/api/issues/WHI-1/documents/plan"`)?.action)
      .toBe("Saved a document on issue");
    expect(parseAgentDashApiCall(`curl -s -I "$PAPERCLIP_API_URL/api/issues/WHI-1"`)?.method).toBe("HEAD");
  });

  it("recognises AgentDash by the configured API base, not any localhost port or look-alike variable", () => {
    expect(parseAgentDashApiCall('curl -s "http://127.0.0.1:9999/api/issues/WHI-1"')).toBeNull();
    expect(parseAgentDashApiCall('curl -s "http://localhost:8080/api/v1/users"')).toBeNull();
    expect(parseAgentDashApiCall('curl -s "$MY_PAPERCLIPISH_EVIL/api/issues/WHI-1"')).toBeNull();
    expect(parseAgentDashApiCall('curl -s "$API/api/issues/WHI-1"')).toBeNull();
    expect(parseAgentDashApiCall('curl -s "https://api.github.com/repos/a/b"')).toBeNull();
    expect(parseAgentDashApiCall('curl -s "https://example.com/api/issues/1"')).toBeNull();
    expect(parseAgentDashApiCall('curl -s "http://127.0.0.1:3489/api/issues/WHI-1"')?.action).toBe("Read issue");
  });

  it("never names a script after one of its calls", () => {
    const multi = [
      "set -e",
      `curl -s "$PAPERCLIP_API_URL/api/issues/WHI-1" ${AUTH}`,
      `curl -s -X DELETE "$PAPERCLIP_API_URL/api/issues/WHI-1/documents/plan"`,
      `curl -s -X PATCH "$PAPERCLIP_API_URL/api/issues/WHI-1" -d '{"status":"cancelled"}'`,
    ].join("\n");
    expect(summarizeToolCall("Bash", { command: multi }).label).toBe("Ran a script (3 AgentDash calls)");
    expect(
      summarizeToolCall("Bash", {
        command: `curl -s "$PAPERCLIP_API_URL/api/issues/WHI-1" && curl -s -X DELETE "$PAPERCLIP_API_URL/api/issues/WHI-1"`,
      }).label,
    ).toBe("Ran a script (2 AgentDash calls)");
    const oneCall = summarizeToolCall("Bash", { command: `curl -s -X DELETE "$PAPERCLIP_API_URL/api/issues/WHI-1/documents/plan"; echo ok` });
    expect(oneCall.label).toBe("Ran a script (1 AgentDash call)");
    expect(oneCall.script).toBeDefined();
    // A preamble alone does not make a script.
    expect(summarizeToolCall("Bash", { command: `set -e\ncurl -s "$PAPERCLIP_API_URL/api/agents/me"` }).label).toBe("Checked its own profile");
  });

  it("names generic noisy commands by their program", () => {
    expect(summarizeToolCall("Bash", { command: 'curl -s "https://example.com/data.json"' }).label).toBe("Ran curl");
    expect(summarizeToolCall("Bash", { command: `python3 scripts/build_checklist.py --input ${"a".repeat(80)}` }).label)
      .toBe("Ran python3");
    expect(summarizeToolCall("Bash", { command: `GITHUB_TOKEN=abc123 gh pr view 12 --json body` }).label).toBe("Ran gh pr");
    expect(commandName("sudo /usr/bin/git log --oneline -n 5")).toBe("git log");
    // Short, plain commands still read as themselves.
    expect(summarizeToolCall("Bash", { command: "git status" }).label).toBe("Ran git status");
    expect(summarizeToolCall("Bash", { command: "pnpm test:run" }).label).toBe("Ran pnpm test:run");
    expect(summarizeToolCall("Bash", { command: "KEYBOARD=us make" }).label).toBe("Ran KEYBOARD=us make");
  });

  it("splits shell words with quotes and stops at a pipe", () => {
    expect(shellWords(`curl -s "a b" 'c d' e\\ f | jq .x`)).toEqual(["curl", "-s", "a b", "c d", "e f"]);
  });
});

describe("redaction (scan 4 lane O1, PR #990 review probes)", () => {
  const SECRET = "SUPERSECRETvalue123";

  // Each of these must leave no trace of SECRET in the redacted text, the
  // collapsed label, or the expanded script.
  const COMMANDS: Array<[string, string]> = [
    ["lowercase authorization", `curl -H "authorization: bearer ${SECRET}" https://x.test`],
    ["x-api-key single quotes", `curl -H 'x-api-key: ${SECRET}' https://x.test`],
    ["--header", `curl --header "Authorization: Bearer ${SECRET}" https://x.test`],
    ["--header= form", `curl --header="X-Api-Key: ${SECRET}" https://x.test`],
    ["-u user:pass", `curl -u admin:${SECRET} https://x.test`],
    ["--user user:pass", `curl --user admin:${SECRET} https://x.test`],
    ["url userinfo", `curl https://admin:${SECRET}@x.test/a`],
    ["?token=", `curl "https://x.test/a?token=${SECRET}"`],
    ["?api_key=", `curl "https://x.test/a?api_key=${SECRET}&b=1"`],
    ["?access_token=", `curl "https://x.test/a?access_token=${SECRET}"`],
    ["?key=", `curl "https://maps.test/a?key=${SECRET}"`],
    ["JSON body Bearer", `curl -d '{"auth":"Bearer ${SECRET}"}' https://x.test`],
    ["JSON body api_key", `curl -d '{"api_key":"${SECRET}"}' https://x.test`],
    ["JSON body password", `curl -d '{"password":"${SECRET}"}' https://x.test`],
    ["TOKEN=x curl", `TOKEN=${SECRET} curl https://x.test`],
    ["PAPERCLIP_API_KEY=", `PAPERCLIP_API_KEY=${SECRET} curl http://127.0.0.1:3100/api/agents/me`],
    ["export", `export OPENAI_API_KEY=${SECRET}`],
    ["quoted env", `API_KEY="${SECRET}" node x.js`],
    ["single-quoted env", `API_KEY='${SECRET}' node x.js`],
    ["Cookie header", `curl -H "Cookie: session=${SECRET}" https://x.test`],
    ["-b cookie", `curl -b "session=${SECRET}" https://x.test`],
    ["Basic auth header", `curl -H "Authorization: Basic ${SECRET}" https://x.test`],
    ["Set-Cookie", `Set-Cookie: sid=${SECRET}; Path=/`],
    ["X-Goog-Api-Key", `curl -H "X-Goog-Api-Key: ${SECRET}" https://x.test`],
    ["api-key (Azure)", `curl -H "api-key: ${SECRET}" https://x.test`],
    ["x-access-token", `curl -H "x-access-token: ${SECRET}" https://x.test`],
    ["PRIVATE-TOKEN gitlab", `curl -H "PRIVATE-TOKEN: ${SECRET}" https://x.test`],
    ["anthropic x-api-key", `curl -H "x-api-key: sk-ant-${SECRET}" https://api.anthropic.com`],
    ["mysql -p", `mysql -uroot -p${SECRET} db`],
    ["postgres url", `psql postgres://user:${SECRET}@db:5432/x`],
    [
      "multi-line script",
      `set -e\nexport PAPERCLIP_API_KEY=${SECRET}\ncurl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" http://127.0.0.1:3100/api/agents/me`,
    ],
    ["multi-line echo heading + secret", `echo "== fetch =="\ncurl -H "X-Api-Key: ${SECRET}" https://x.test`],
    ["header split across escaped newline", `curl \\\n  -H "Authorization: Bearer ${SECRET}" \\\n  https://x.test`],
    ["authorization with escaped quote inside", `curl -H "Authorization: Bearer ab\\"${SECRET}" https://x.test`],
    ["--password option", `deploy --password ${SECRET} --env prod`],
    // PR #990 re-review (probe 3).
    ["python call api_key=", `python3 -c 'c=Client(api_key="${SECRET}")'`],
    ["python call api_key unquoted", `python3 -c 'c=Client(api_key=${SECRET})'`],
    ["form client_secret", `curl -d "client_id=a&client_secret=${SECRET}" https://x.test/oauth`],
    ["git url with token", `git clone https://oauth2:${SECRET}@gitlab.com/a/b.git`],
  ];

  it("redacts Stripe keys and webhook secrets, in labels too", () => {
    const live = "sk_live_51HxYzAbCdEfGhIjKlMnOp";
    for (const text of [live, "rk_test_51HxYzAbCdEfGhIjKl", "whsec_AbCdEfGhIjKlMnOp12", `STRIPE_SECRET_KEY=${live}`]) {
      expect(redactSecrets(text)).not.toMatch(/[rs]k_(?:live|test)_51|whsec_AbC/);
    }
    const bare = summarizeToolCall("Bash", { command: `node pay.js ${live}` });
    expect(bare.label).toBe("Ran node");
    expect(bare.script).not.toContain(live);
    const wrote = summarizeToolCall("Bash", { command: `cat > /tmp/${live}.txt <<'EOF'\nhi\nEOF` });
    expect(wrote.label).not.toContain("sk_live_51");
    expect(wrote.label).toMatch(/^Wrote /);
    expect(redactSecrets(`stripe charges list --api-key ${live}`)).not.toContain(live);
  });

  it("stops an unquoted assignment value at a parenthesis", () => {
    expect(redactSecrets(`c=Client(api_key=${SECRET})`)).toBe("c=Client(api_key=•••• hidden)");
    expect(redactSecrets(`c=Client(api_key="${SECRET}")`)).toBe('c=Client(api_key="•••• hidden")');
  });

  it.each(COMMANDS)("%s", (_label, command) => {
    expect(redactSecrets(command)).not.toContain(SECRET);
    const summary = summarizeToolCall("Bash", { command });
    expect(summary.label).not.toContain(SECRET);
    expect(summary.script ?? "").not.toContain(SECRET);
  });

  it("redacts tool output: the collapsed outcome and the full text", () => {
    const outputs = [
      `{"id":"k1","apiKey":"${SECRET}","name":"default"}`,
      `{"token":"${SECRET}"}`,
      `{"key":"pcp_${SECRET}"}`,
      `{"access_token":"${SECRET}","token_type":"bearer"}`,
      `OPENAI_API_KEY=sk-${SECRET}`,
      `Authorization: Bearer ${SECRET}`,
    ];
    for (const output of outputs) {
      expect(redactSecrets(output)).not.toContain(SECRET);
      expect(summarizeToolOutcome(output, "completed")).not.toContain(SECRET);
      expect(summarizeToolOutcome(output, "running")).not.toContain(SECRET);
    }
  });

  it("redacts non-command labels (fetched URLs, MCP arguments)", () => {
    expect(summarizeToolCall("WebFetch", { url: `https://x.test/a?token=${SECRET}` }).label).not.toContain(SECRET);
    expect(summarizeToolCall("mcp__foo__bar", { url: `https://x.test/a?api_key=${SECRET}` }).label).not.toContain(SECRET);
  });

  it("redacts nested values and credential-named keys before pretty-printing", () => {
    const redacted = redactSecretsInValue({ command: `curl -H "Authorization: Bearer ${SECRET}" u`, apiKey: SECRET, env: { DB_PASSWORD: SECRET }, list: [`token=${SECRET}`], key: "plan" });
    expect(JSON.stringify(redacted)).not.toContain(SECRET);
    expect(redacted.key).toBe("plan");
  });

  it("leaves ordinary text alone", () => {
    for (const benign of [
      "git log --oneline",
      "KEYBOARD=us make",
      "echo MONKEY=banana",
      "grep -r 'TOKEN=' src",
      "cat docs/authorization.md",
      "Authorization: required for this endpoint",
      "ssh -p 22 host",
      "git checkout -b feature/x",
      'TOKEN=$(cat ~/.token) && echo ok',
    ]) {
      expect(redactSecrets(benign)).toBe(benign);
    }
  });

  it("keeps the header name and auth scheme, and is idempotent", () => {
    expect(redactSecrets('-H "Authorization: Bearer abc.def"')).toBe('-H "Authorization: Bearer •••• hidden"');
    expect(redactSecrets("--token s3cr3t-value")).toBe("--token •••• hidden");
    expect(redactSecrets("API_KEY=s3cr3t pnpm x")).toBe("API_KEY=•••• hidden pnpm x");
    const once = redactSecrets(`curl -u a:${SECRET} -H "X-Api-Key: ${SECRET}" "https://x.test?token=${SECRET}"`);
    expect(redactSecrets(once)).toBe(once);
  });
});

// AgentDash (scan 4 lane O1, hosted canary): heredoc writes and JSON outputs
// were shown raw in the Readable transcript.
describe("heredoc writes and JSON outputs (scan 4 lane O1)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("summarises a heredoc write as Wrote <file name>, never the absolute path", () => {
    const command = "cat > /tmp/agentdash-xyz/doc.json << 'EOF'\n{\n  \"title\": \"Checklist\",\n  \"body\": \"x\"\n}\nEOF";
    const summary = summarizeToolCall("Bash", { command });
    expect(summary.label).toBe("Wrote doc.json");
    expect(summary.label).not.toContain("/tmp");
    expect(summary.script).toBe(command);
    expect(heredocWriteTarget("cat <<EOF > notes.md")).toBe("notes.md");
    expect(summarizeToolCall("Bash", { command: "tee -a /var/log/run.log <<-EOF\n\tline\n\tEOF" }).label).toBe("Wrote run.log");
    expect(
      summarizeToolCall("Bash", { command: "cat > /tmp/a.json <<'EOF'\n{}\nEOF\ncat > /tmp/b.md <<'EOF'\nhi\nEOF" }).label,
    ).toBe("Wrote a.json +1 more");
  });

  it("does not read heredoc body lines as statements", () => {
    vi.stubGlobal("window", { location: { host: "127.0.0.1:3489", hostname: "127.0.0.1" } });
    const command = [
      "cat > /tmp/body.json << 'EOF'",
      '{"body": "rm -rf / && curl -X DELETE http://127.0.0.1:3489/api/issues/WHI-1"}',
      "EOF",
      'curl -s -X PUT "$PAPERCLIP_API_URL/api/issues/WHI-1/documents/checklist" -H "Authorization: Bearer $PAPERCLIP_API_KEY" -d @/tmp/body.json',
    ].join("\n");
    // The scratch file is set-up; the one real call is named.
    expect(summarizeToolCall("Bash", { command }).label).toBe("Saved a document on issue WHI-1");
    // Another program reading a heredoc is named by its program.
    expect(summarizeToolCall("Bash", { command: "python3 - <<'EOF'\nprint(1)\nEOF" }).label).toBe("Ran python3");
  });

  it("summarises JSON outputs as a short phrase", () => {
    expect(summarizeJsonOutput('{"id":"9eaca194","identifier":"WHI-1","title":"Checklist","status":"in_review"}')).toBe("Got issue WHI-1");
    expect(summarizeJsonOutput(JSON.stringify(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}`, i]))))).toBe("Response: 12 fields");
    expect(summarizeJsonOutput('[{"a":1},{"a":2},{"a":3}]')).toBe("Response: 3 items");
    expect(summarizeJsonOutput("[]")).toBe("Response: no items");
    expect(summarizeJsonOutput('{"items":[1,2],"nextCursor":null}')).toBe("Response: 2 items");
    expect(summarizeJsonOutput('{"error":"Issue not found"}')).toBe("Error: Issue not found");
    expect(summarizeJsonOutput('{"id":"c1"}')).toBe("Response: 1 field");
    expect(summarizeJsonOutput("not json {")).toBeNull();
    // A truncated JSON body still gets a phrase (see the multi-body tests).
    expect(summarizeJsonOutput("{broken")).toBe("Response (JSON)");
  });

  it("uses the JSON phrase for the collapsed outcome, redacted", () => {
    const output = JSON.stringify({ identifier: "WHI-1", title: "x" }, null, 2);
    expect(summarizeToolOutcome(output, "completed")).toBe("Got issue WHI-1");
    expect(summarizeToolOutcome('{"error":"Issue not found"}', "error")).toBe("Error: Issue not found");
  });

  // PR #990 re-review (probe 3).
  it("collapses an error about a key, token or secret to just 'Error'", () => {
    expect(summarizeToolOutcome('{"error":"bad token sk-abcdefghijklmnopqrstu"}', "error")).toBe("Error");
    expect(summarizeToolOutcome('{"error":{"message":"Incorrect API key provided: sk-proj-Zq9SECRETvalue77"}}', "completed")).toBe("Error");
    expect(summarizeToolOutcome("Error: 401 Unauthorized for api_key Zq9SECRETvalue77", "completed")).toBe("Error");
    expect(summarizeToolOutcome("Error: ECONNREFUSED 127.0.0.1:6379", "error")).toBe("Error: ECONNREFUSED 127.0.0.1:6379");
    // A non-error line that mentions tokens is left alone.
    expect(summarizeToolOutcome("tokens: 1234 in / 567 out", "completed")).toBe("tokens: 1234 in / 567 out");
  });

  it("redacts the JSON phrase after JSON.parse decodes \\u escapes", () => {
    const SECRET = "Zq9SECRETvalue77";
    for (const output of [
      `{"error":"invalid \\u0073k-ant-${SECRET}abcdef"}`,
      `{"error":"bad \\u0042earer ${SECRET}"}`,
      `{"message":"see \\u0073k_live_51HxYzAbCdEfGhIjKlMnOp"}`,
    ]) {
      const outcome = summarizeToolOutcome(output, "completed");
      expect(outcome).not.toContain(SECRET);
      expect(outcome).not.toContain("sk_live_51");
      expect(summarizeToolOutcome(output, "error")).not.toContain(SECRET);
    }
    expect(summarizeToolOutcome("plain line\nsecond", "completed")).toBe("plain line");
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

// AgentDash (batch 2, insurance-agency canary): Hermes binds the API base
// once (`API="$PAPERCLIP_API_URL/api"`) and curls `"$API/<route>"` after
// that — the unresolved variable read as a bare "Ran curl" row. And
// execute_code's `--- stderr ---` section divider became the row's outcome.
describe("script-local API variables and Hermes rows (batch 2)", () => {
  const AUTH = '-H "Authorization: Bearer $PAPERCLIP_API_KEY"';

  beforeEach(() => {
    vi.stubGlobal("window", { location: { host: "127.0.0.1:3489", hostname: "127.0.0.1" } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves a leading $VAR in the curl URL against the script's assignments", () => {
    const env = scriptEnv('API="$PAPERCLIP_API_URL/api"');
    expect(parseAgentDashApiCall('curl -s "$API/issues/WHI-1"', env)).toMatchObject({
      method: "GET",
      route: "/api/issues/:id",
      issueRef: "WHI-1",
      action: "Read issue",
    });
    // Chained bindings: BASE=$PAPERCLIP_API_URL; API=$BASE/api.
    const chained = scriptEnv('BASE="$PAPERCLIP_API_URL"\nAPI="$BASE/api"');
    expect(parseAgentDashApiCall('curl -s -X PATCH "$API/issues/WHI-2"', chained)?.action)
      .toBe("Updated issue");
    // A literal base bound to a variable resolves the same way.
    const literal = scriptEnv('API="http://127.0.0.1:3489/api"');
    expect(parseAgentDashApiCall('curl -s "$API/issues/WHI-1"', literal)?.issueRef).toBe("WHI-1");
  });

  it("reads the variable-backed calls when the whole script is summarised", () => {
    const script = [
      'API="$PAPERCLIP_API_URL/api"',
      `curl -s "$API/issues/WHI-1" ${AUTH}`,
      `curl -s -X PATCH "$API/issues/WHI-1" ${AUTH} -d '{"status":"in_review"}'`,
    ].join("\n");
    expect(summarizeToolCall("Bash", { command: script }).label).toBe("Ran a script (2 AgentDash calls)");
    // One bound call alone is named by its action.
    expect(
      summarizeToolCall("Bash", {
        command: `API="$PAPERCLIP_API_URL/api"\ncurl -s "$API/issues/WHI-1" ${AUTH}`,
      }).label,
    ).toBe("Read issue WHI-1");
  });

  it("still refuses variables it cannot resolve or that do not point at an /api base", () => {
    const env = scriptEnv('API="$PAPERCLIP_API_URL/api"');
    expect(parseAgentDashApiCall('curl -s "$UNKNOWN/api/issues/WHI-1"', env)).toBeNull();
    const notApi = scriptEnv('API="https://api.github.com"');
    expect(parseAgentDashApiCall('curl -s "$API/repos/a/b"', notApi)).toBeNull();
    // A variable bound to a foreign host is never AgentDash.
    const other = scriptEnv('API="http://127.0.0.1:9999/api"');
    expect(parseAgentDashApiCall('curl -s "$API/issues/WHI-1"', other)).toBeNull();
  });

  it("shows only the file name for a Hermes write_file detail path", () => {
    const summary = summarizeToolCall("write_file", {
      detail: "/paperclip/.hermes/profiles/agent-1/notes/onboarding.md",
    });
    expect(summary.label).toBe("Write onboarding.md");
    expect(summary.label).not.toContain("/paperclip");
    // An explicit file_path still wins over detail.
    expect(
      summarizeToolCall("write_file", { file_path: "docs/x.md", detail: "/paperclip/.hermes/other.md" }).label,
    ).toBe("Write docs/x.md");
  });

  it("folds an execute_code section marker into the row's real outcome", () => {
    const output = "\n--- stderr ---\nSyntaxWarning: \"\\W\" is an invalid escape sequence";
    expect(summarizeToolOutcome(output, "error")).toBe('SyntaxWarning: "\\W" is an invalid escape sequence');
    expect(summarizeToolOutcome(output, "completed")).toBe(
      'SyntaxWarning: "\\W" is an invalid escape sequence',
    );
    // A marker embedded mid-line splits there too.
    expect(summarizeToolOutcome("all good -- stderr -- DeprecationWarning: x", "completed"))
      .toBe("DeprecationWarning: x");
    // A marker with nothing after it has nothing to quote.
    expect(summarizeToolOutcome("--- stderr ---", "error")).toBe("Failed");
    expect(summarizeToolOutcome("--- stderr ---", "completed")).toBe("Done");
  });

  it("summarises each body when tool output holds several JSON values", () => {
    expect(
      summarizeJsonOutput(
        '{"identifier":"WHI-1","title":"x"}{"items":[1,2,3,4]}',
      ),
    ).toBe("Got issue WHI-1 · Response: 4 items");
    // NDJSON lines split the same way.
    expect(
      summarizeJsonOutput('{"identifier":"WHI-1"}\n{"a":1,"b":2,"c":3,"d":4}'),
    ).toBe("Got issue WHI-1 · Response: 4 fields");
  });

  it("degrades a truncated JSON body to its issue ref or a generic label", () => {
    expect(summarizeJsonOutput('{"identifier":"WHI-7","title":"half-wri')).toBe(
      "Got issue WHI-7",
    );
    expect(summarizeJsonOutput('{"title":"half-wri')).toBe("Response (JSON)");
    // A complete body followed by a truncated tail keeps both phrases.
    expect(
      summarizeJsonOutput('{"a":1,"b":2}{"identifier":"WHI-9","titl'),
    ).toBe("Response: 2 fields · Got issue WHI-9");
    expect(summarizeJsonOutput("plain text")).toBeNull();
  });

  // AgentDash (batch 3): a script result is the response body plus the shell's
  // own noise around it — a KEY_SET echo before it, an `exit code N` tail after
  // it (the Hermes envelope appends one on failure), a `--- stderr ---` block.
  // None of those make the body stop being a response.
  it("summarises JSON bodies surrounded by script noise instead of showing raw JSON", () => {
    const company =
      '{"id":"9862d76d-aa9f-4fb4-a344-a13d61d0945e","name":"Acme Robotics","description":"Robots","issuePrefix":"ACM"}';
    expect(summarizeJsonOutput(`${company}\nexit code 1`)).toBe("Got company Acme Robotics · exit code 1");
    expect(
      summarizeJsonOutput(`KEY_SET\n${company}`),
    ).toBe("KEY_SET · Got company Acme Robotics");
    // stderr after a body stays visible — the error is part of the outcome.
    expect(
      summarizeJsonOutput(`${company}\n--- stderr ---\ncurl: (22) The requested URL returned error: 404`),
    ).toBe("Got company Acme Robotics · curl: (22) The requested URL returned error: 404");
    // Both sides at once, plus a second body.
    expect(
      summarizeJsonOutput(
        `KEY_SET\n{"identifier":"ACM-6","title":"x"}\n=== COMMENTS ===\n{"items":[1,2]}`,
      ),
    ).toBe("KEY_SET · Got issue ACM-6 · === COMMENTS === · Response: 2 items");
    // Text with no JSON body is still not JSON output.
    expect(summarizeJsonOutput("plain text")).toBeNull();
    expect(summarizeJsonOutput("not json {")).toBeNull();
    // Prose braces that do not parse do not count as a body.
    expect(summarizeJsonOutput("expected {x} got {y}")).toBeNull();
  });

  it("names the records a call returned — company, agent, document, revision, comment", () => {
    expect(
      summarizeJsonOutput(
        '{"id":"9862d76d","name":"Acme Robotics","description":"Robots","issuePrefix":"ACM","budgetMonthlyCents":0}',
      ),
    ).toBe("Got company Acme Robotics");
    expect(
      summarizeJsonOutput(
        '{"id":"a1","companyId":"c1","name":"Quinn","urlKey":"quinn","role":"content_lead","adapterType":"hermes_local"}',
      ),
    ).toBe("Got agent Quinn");
    expect(
      summarizeJsonOutput(
        '{"id":"70cb28ef","companyId":"c1","issueId":"i1","key":"product-description","title":"Gripper product description","format":"markdown"}',
      ),
    ).toBe("Got document Gripper product description");
    expect(
      summarizeJsonOutput(
        '{"id":"r1","documentId":"d1","issueId":"i1","revisionNumber":2,"title":"Draft v2"}',
      ),
    ).toBe("Got document revision 2 — Draft v2");
    expect(
      summarizeJsonOutput('{"id":"cm1","issueId":"i1","body":"Looks good — ship the second sentence"}'),
    ).toBe("Got comment — Looks good — ship the second sentence");
    // A pull-request work product has issueId + title but is not a document.
    expect(
      summarizeJsonOutput('{"id":"wp1","issueId":"i1","type":"pull_request","title":"PR #12 health badge"}'),
    ).toBe("Got PR #12 health badge");
    // A wrapped entity names what is inside.
    expect(
      summarizeJsonOutput('{"issue":{"identifier":"ACM-2","title":"Brief"},"extra":true}'),
    ).toBe("Got issue ACM-2");
    // A truncated company still names what it could.
    expect(
      summarizeJsonOutput('{"id":"9862d76d","name":"Acme Robotics","des'),
    ).toBe("Got Acme Robotics");
    // An opaque object still falls back to its field count.
    expect(summarizeJsonOutput('{"id":"c1","x":2}')).toBe("Response: 2 fields");
  });

  it("keeps JSON summary phrases redacted", () => {
    // The company name slot must not smuggle a secret past redaction.
    const result = summarizeToolOutcome(
      '{"id":"c1","name":"key sk-abcdefghijklmnopqrstuvwxyz","issuePrefix":"ACM"}',
      "completed",
    );
    expect(result).not.toContain("sk-");
    expect(result).toContain("Got company");
  });

  it("drops a write_file outcome that echoes the file path and a duration", () => {
    const input = { detail: "/paperclip/.hermes/profiles/agent-1/notes/onboarding.md" };
    expect(
      summarizeToolOutcome(
        "/paperclip/.hermes/profiles/agent-1/notes/onboarding.md (12ms)",
        "completed",
        input,
      ),
    ).toBe("Done");
    // A bare echo of the call's path is the same noise without the duration.
    expect(
      summarizeToolOutcome(input.detail as string, "completed", input),
    ).toBe("Done");
    // Path plus a duration collapses even without a matching call input.
    expect(summarizeToolOutcome("/var/state/notes.md · 0.4s", "completed")).toBe("Done");
    // A path that is not the call's own is real output and stays visible.
    expect(
      summarizeToolOutcome("/etc/hostname", "completed", input),
    ).toBe("/etc/hostname");
    // The expanded text of a failing call keeps its verdict.
    expect(summarizeToolOutcome(input.detail as string, "error", input)).toBe("Failed");
    // The call's path followed by an error is a finding, not an echo.
    expect(
      summarizeToolOutcome(`${input.detail}: Permission denied`, "error", input),
    ).toBe(`${input.detail}: Permission denied`);
    expect(
      summarizeToolOutcome(
        "/repo/src/a.ts(3,1): error TS2307: Cannot find module",
        "error",
        { detail: "/repo/src/a.ts" },
      ),
    ).toBe("/repo/src/a.ts(3,1): error TS2307: Cannot find module");
  });

  it("shortens instance workspace paths in result text", () => {
    const ws = "/paperclip/instances/default/workspaces/43e8155e-a1b2-4c3d-9e8f-001122334455";
    expect(summarizeJsonOutput(`wrote ${ws}/scan.md\n{"a":1}`)).toBe("wrote scan.md · Response: 1 field");
    expect(summarizeToolOutcome(`saved ${ws}/notes/plan.md`, "completed")).toBe("saved notes/plan.md");
  });
});
