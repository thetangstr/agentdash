import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareGenerated, diffSummary, formatProblems } from "./check-mcp-reference-drift.mjs";
import {
  CONNECT_PAGE_REL,
  GENERATED_FILES,
  PRIVATE_PROFILE_LABEL,
  TOOL_PAGES,
  generateMcpReference,
  inputTable,
  omitEngagementSections,
  redactPrivateProfile,
  renderConnectPage,
  renderPlaybooksPage,
  renderToolPage,
  schemaType,
  withoutCommitLine,
  writeGenerated,
} from "../docs/generate-mcp-reference.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), "mcp-reference-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

const commitLine = (sha) => `> Generated at commit \`${sha}\` by \`scripts/docs/generate-mcp-reference.mjs\`.`;

test("a file that differs only in its generating commit is current", () => {
  const page = (sha) => `---\ntitle: "X"\n---\n\n${commitLine(sha)}\n\nBody.\n`;
  const generated = fixture({ "docs/mcp/tools/a.md": page("abc1234") });
  const committed = fixture({ "docs/mcp/tools/a.md": page("0123456789") });
  try {
    assert.deepEqual(compareGenerated({ generatedRoot: generated, committedRoot: committed, expected: ["docs/mcp/tools/a.md"] }), []);
  } finally {
    rmSync(generated, { recursive: true, force: true });
    rmSync(committed, { recursive: true, force: true });
  }
});

test("reports stale, missing and unexpected files", () => {
  const generated = fixture({
    "docs/mcp/tools/a.md": `${commitLine("abc1234")}\n\none\ntwo\nthree\n`,
    "docs/mcp/tools/b.md": "new page\n",
  });
  const committed = fixture({
    "docs/mcp/tools/a.md": `${commitLine("abc1234")}\n\none\nTWO\nthree\n`,
    "docs/mcp/tools/gone.md": "a toolset that no longer exists\n",
  });
  try {
    const problems = compareGenerated({
      generatedRoot: generated,
      committedRoot: committed,
      expected: ["docs/mcp/tools/a.md", "docs/mcp/tools/b.md"],
    });
    assert.deepEqual(
      problems.map((problem) => [problem.rel, problem.kind]),
      [
        ["docs/mcp/tools/a.md", "stale"],
        ["docs/mcp/tools/b.md", "missing"],
        ["docs/mcp/tools/gone.md", "unexpected"],
      ],
    );
    assert.match(problems[0].detail, /first difference at line 4/);
    assert.match(problems[0].detail, /- TWO/);
    assert.match(problems[0].detail, /\+ two/);
    assert.match(formatProblems(problems), /pnpm docs:mcp-reference/);
  } finally {
    rmSync(generated, { recursive: true, force: true });
    rmSync(committed, { recursive: true, force: true });
  }
});

test("diffSummary bounds the differing region from both ends", () => {
  const summary = diffSummary("a\nb\nc\nd\n", "a\nx\ny\nd\n");
  assert.match(summary, /committed lines 2-3 vs generated lines 2-3/);
});

test("withoutCommitLine blanks only the commit", () => {
  assert.equal(withoutCommitLine(`${commitLine("abc1234")}\nrest`), withoutCommitLine(`${commitLine("fedcba987")}\nrest`));
  assert.notEqual(withoutCommitLine(`${commitLine("abc1234")}\nrest`), withoutCommitLine(`${commitLine("abc1234")}\nother`));
});

test("writeGenerated leaves a file alone when only the commit would change", () => {
  const root = fixture({ "p.md": `${commitLine("1111111")}\nbody\n` });
  try {
    assert.deepEqual(writeGenerated(new Map([["p.md", `${commitLine("2222222")}\nbody\n`]]), root), []);
    assert.match(readFileSync(path.join(root, "p.md"), "utf8"), /1111111/);
    assert.deepEqual(writeGenerated(new Map([["p.md", `${commitLine("2222222")}\nchanged\n`]]), root), ["p.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema types render compactly", () => {
  assert.equal(schemaType({ type: "string" }), "string");
  assert.equal(schemaType({ type: "string", format: "uuid" }), "string (uuid)");
  assert.equal(schemaType({ anyOf: [{ type: "string" }, { type: "null" }] }), "string | null");
  assert.equal(schemaType({ type: "string", enum: ["a", "b"] }), '`"a"` | `"b"`');
  assert.equal(schemaType({ type: "array", items: { type: "integer" } }), "array of integer");
  assert.equal(schemaType({ type: "object", additionalProperties: {} }), "map of any");
  assert.equal(schemaType({}), "any");
  assert.equal(
    schemaType({
      oneOf: [
        { type: "object", properties: { kind: { const: "company" }, id: { type: "string" } }, required: ["kind", "id"] },
        { type: "object", properties: { kind: { const: "self" } }, required: ["kind"] },
      ],
    }),
    '{ kind: `"company"`, id: string } | { kind: `"self"` }',
  );
});

test("input tables flatten nested objects and escape pipes", () => {
  const table = inputTable({
    type: "object",
    properties: {
      kind: { type: "string", enum: ["x", "y"], description: "a | b" },
      items: {
        type: "array",
        items: { type: "object", properties: { agent: { type: "string" } }, required: ["agent"] },
      },
      limit: { type: "integer", default: 10, maximum: 200 },
    },
    required: ["kind"],
  });
  assert.equal(
    table,
    [
      "| Property | Type | Required | Description |",
      "|---|---|---|---|",
      '| `kind` | `"x"` \\| `"y"` | yes | a \\| b |',
      "| `items` | array of object | no |  |",
      "| `items[].agent` | string | yes |  |",
      "| `limit` | integer | no | Default: `10`. Maximum: 200. |",
    ].join("\n"),
  );
  assert.equal(inputTable({ type: "object", properties: {} }), "No input.");
});

test("input tables distinguish inclusive from exclusive numeric bounds", () => {
  assert.equal(inputTable({
    type: "object",
    properties: {
      inclusive: { type: "number", minimum: -2.5, maximum: 7.25 },
      exclusive: { type: "integer", exclusiveMinimum: 0, exclusiveMaximum: 500 },
    },
  }), [
    "| Property | Type | Required | Description |",
    "|---|---|---|---|",
    "| `inclusive` | number | no | Minimum: -2.5. Maximum: 7.25. |",
    "| `exclusive` | integer | no | Exclusive minimum: 0. Exclusive maximum: 500. |",
  ].join("\n"));
});

test("the private profile name is replaced in every spelling, and the page says where", () => {
  const page = `${commitLine("abc1234")}\n\nAgentDash-MK: does a thing. Enum: "agentdash_mk". Also AgentDash MK and agentdashmk.\n`;
  const redacted = redactPrivateProfile(page);
  assert.doesNotMatch(redacted, /agentdash[\s_-]?mk/i);
  assert.ok(redacted.includes(`${PRIVATE_PROFILE_LABEL}: does a thing`));
  assert.ok(redacted.includes(`Also ${PRIVATE_PROFILE_LABEL} and ${PRIVATE_PROFILE_LABEL}.`));
  assert.match(redacted, /in 4 places/);
  assert.equal(redactPrivateProfile("no profile here"), "no profile here");
});

test("a private profile enum value is omitted, not relabeled", () => {
  assert.equal(schemaType({ type: "string", enum: ["default", "agentdash_mk"] }), '`"default"` (1 value omitted)');
  assert.equal(schemaType({ type: "string", enum: ["default", "agentdash mk", "agentdashmk"] }), '`"default"` (2 values omitted)');
});

const tool = (name, description = "Does a thing.") => ({ name, description, inputSchema: { type: "object", properties: {} } });

test("an engagement-specific tool is left off its page, and the header counts it", () => {
  const surface = { connections: { bridge: { tools: [tool("inbox_sync"), tool("ross_request_status"), tool("request_ross_assessment"), tool("crossover_report")] } } };
  const page = renderToolPage({ surface: "bridge", rel: "docs/mcp/tools/bridge.md", title: "Bridge tools" }, surface, "abc1234");
  assert.match(page, /^> 2 tools omitted: engagement-specific\.$/m);
  assert.match(page, /\*\*4 tools\*\* — measured: the length of the `tools\/list` response; 2 are documented here and 2 are omitted/);
  assert.doesNotMatch(page, /ross_|_ross/);
  assert.match(page, /^## `inbox_sync`$/m);
  assert.match(page, /^## `crossover_report`$/m, "a word that merely contains the letters is kept");
  const single = renderToolPage({ surface: "bridge", rel: "x", title: "X" }, { connections: { bridge: { tools: [tool("a"), tool("ross_x")] } } }, "abc1234");
  assert.match(single, /^> 1 tool omitted: engagement-specific\.$/m);
  const none = renderToolPage({ surface: "bridge", rel: "x", title: "X" }, { connections: { bridge: { tools: [tool("a")] } } }, "abc1234");
  assert.doesNotMatch(none, /omitted/);
});

test("an engagement-specific playbook section is left out whole and the rest is byte for byte", () => {
  const playbook = "# Title\n\nIntro.\n\n## Keep\nAcross the board.\n\n## Asking Ross\nAsk Ross.\n\n## Also gone\nUse `ross_request_status`.\n\n## Last\nEnd.\n";
  const { text, omitted } = omitEngagementSections(playbook);
  assert.equal(omitted, 2);
  assert.equal(text, "# Title\n\nIntro.\n\n## Keep\nAcross the board.\n\n## Last\nEnd.\n");
  const surface = {
    playbooks: [{ name: "P", file: "p.ts", text: playbook }],
    connections: Object.fromEntries(
      ["setup", "setup-agent", "agent", "agent-agent", "assistant", "human", "bridge", "bridge-agent"].map((id) => [id, { instructions: playbook }]),
    ),
  };
  const page = renderPlaybooksPage(surface, "abc1234");
  assert.match(page, /^> 2 sections omitted: engagement-specific\.$/m);
  assert.match(page, /2 sections omitted: engagement-specific\.\n/);
  assert.doesNotMatch(page, /\bRoss\b|ross_/);
});

test("the connect page is the README with its heading moved to front matter", () => {
  const page = renderConnectPage("# agentdash-connect\n\nIntro.\n\n## Usage\n", "abc1234");
  assert.match(page, /^---\ntitle: "agentdash-connect"\n/);
  assert.match(page, /packages\/connect\/README\.md/);
  assert.match(page, /Intro\.\n\n## Usage\n$/);
  assert.throws(() => renderConnectPage("no heading", "abc1234"));
});

// End to end, against the real server source: the counts each page states are
// the tools it documents, and nothing private survives.
test("the real reference: every page states the count it documents", async () => {
  const files = await generateMcpReference(REPO_ROOT, { commit: "abc1234" });
  assert.deepEqual([...files.keys()], GENERATED_FILES);
  for (const page of TOOL_PAGES) {
    const content = files.get(page.rel);
    const stated = Number(/\*\*(\d+) tools\*\*/.exec(content)?.[1]);
    const omitted = Number(/^> (\d+) tools? omitted: engagement-specific\.$/m.exec(content)?.[1] ?? 0);
    const documented = (content.match(/^#{2,3} `[^`]+`$/gm) ?? []).length;
    assert.ok(stated > 0, `${page.rel} states no count`);
    assert.equal(documented + omitted, stated, `${page.rel}: states ${stated} tools, documents ${documented}, omits ${omitted}`);
  }
  for (const [rel, content] of files) {
    assert.doesNotMatch(content, /agentdash[\s_-]?mk/i, rel);
    assert.doesNotMatch(content, /(?<![A-Za-z])[Rr]oss(?![a-z])/, rel);
    assert.doesNotMatch(content, /\{\{/, rel);
  }
  assert.ok(files.get(CONNECT_PAGE_REL).includes("npx -y agentdash-connect@latest"));
});

test("an engagement-named enum or const value is left out of the input table, and says so", () => {
  const value = ["exec", "os_request"].join("");
  assert.equal(schemaType({ type: "string", const: value }), "string (1 value omitted: engagement-specific)");
  assert.equal(schemaType({ type: "string", enum: ["manual", value] }), '`"manual"` (1 value omitted: engagement-specific)');
  assert.equal(schemaType({ type: "string", enum: ["a", "b"] }), '`"a"` | `"b"`');
});
