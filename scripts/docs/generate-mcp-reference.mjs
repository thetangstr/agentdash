#!/usr/bin/env node
// Generate the MCP reference pages from the MCP server itself:
//
//   docs/mcp/tools/<setup|agent|assistant|human|bridge>.md — one page per surface
//   docs/mcp/resources.md                                  — agentdash:// resources and templates
//   docs/mcp/playbooks.md                                  — the four playbook constants, verbatim
//   docs/cli/agentdash-connect.md                          — packages/connect/README.md, as a page
//
// doc/plans/2026-10-01-public-docs-section.md, "Generated references and drift
// checks": hand-written references for 124 tools are wrong within a week, so
// these pages are never edited by hand. scripts/ci/check-mcp-reference-drift.mjs
// regenerates them and fails a PR whose committed copy differs.
//
// How the data is read. Nothing here re-implements the server. The TypeScript
// source of packages/mcp-server is bundled with esbuild (already that package's
// build tool), `createAgentDashServer` is started once per connection shape,
// and an MCP client talks to it over the SDK's in-memory transport. So a tool
// page is the `tools/list` response, the resources page is `resources/list` and
// `resources/templates/list`, and which playbook a connection gets is the
// server's `instructions` — exactly what a harness is told, read the way a
// harness reads it. Reading source rather than dist/ means a stale build cannot
// produce a stale reference.
//
// No network. Tool registration needs none: the API client is constructed
// against an unroutable address and never called. The one request a listing
// makes is the human toolset's identity probe (src/human.ts calls it before
// answering tools/list); `fetch` is replaced for the run with a stub that
// answers that probe and throws on anything else, so a future listing that
// starts calling the API fails here instead of quietly depending on it.
//
// Deterministic: registration order, no timestamps. The one line that is not a
// function of the source is the generating commit; the drift check ignores it,
// and a rerun keeps the existing line when nothing else changed, so the
// header names the commit the content was last generated at.
//
// Usage: node scripts/docs/generate-mcp-reference.mjs   (or: pnpm docs:mcp-reference)

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const GENERATOR_REL = "scripts/docs/generate-mcp-reference.mjs";
export const MCP_SERVER_REL = "packages/mcp-server";
export const CONNECT_README_REL = "packages/connect/README.md";

/** Every file this script writes, docs-relative to the repo root. */
export const TOOL_PAGES = [
  { surface: "setup", rel: "docs/mcp/tools/setup.md", title: "Setup toolset" },
  { surface: "agent", rel: "docs/mcp/tools/agent.md", title: "Agent toolset" },
  { surface: "assistant", rel: "docs/mcp/tools/assistant.md", title: "Assistant toolset" },
  { surface: "human", rel: "docs/mcp/tools/human.md", title: "Human toolset" },
  { surface: "bridge", rel: "docs/mcp/tools/bridge.md", title: "Bridge tools" },
];
export const RESOURCES_REL = "docs/mcp/resources.md";
export const PLAYBOOKS_REL = "docs/mcp/playbooks.md";
export const CONNECT_PAGE_REL = "docs/cli/agentdash-connect.md";

export const GENERATED_FILES = [
  ...TOOL_PAGES.map((page) => page.rel),
  RESOURCES_REL,
  PLAYBOOKS_REL,
  CONNECT_PAGE_REL,
];

/** The header line naming the generating commit — the only line allowed to differ. */
export const COMMIT_LINE = /^> Generated at commit `[0-9a-f]{4,40}` by `scripts\/docs\/generate-mcp-reference\.mjs`\.$/m;

/** Content with the commit line blanked, for comparisons. */
export function withoutCommitLine(text) {
  return text.replace(COMMIT_LINE, "> Generated at commit `<commit>` by `scripts/docs/generate-mcp-reference.mjs`.");
}

// ---------------------------------------------------------------------------
// Reading the server
// ---------------------------------------------------------------------------

// Relative to packages/mcp-server/src, which is the bundle's resolveDir.
const ENTRY = `
export { createAgentDashServer, AGENTDASH_TOOLSETS } from "./index.ts";
export { PLAYBOOK, STEWARD_PLAYBOOK, ASSISTANT_PLAYBOOK } from "./playbook.ts";
export { HUMAN_PLAYBOOK } from "./human.ts";
export { Client } from "@modelcontextprotocol/sdk/client/index.js";
export { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
export { ASSISTANT_SCOPE_READ, ASSISTANT_SCOPE_WORK, ASSISTANT_SCOPE_DECIDE } from "@paperclipai/shared";
`;

async function loadServerModule(repoRoot) {
  const serverDir = path.join(repoRoot, MCP_SERVER_REL);
  const requireFromServer = createRequire(path.join(serverDir, "package.json"));
  const esbuild = requireFromServer("esbuild");
  const result = await esbuild.build({
    stdin: { contents: ENTRY, resolveDir: path.join(serverDir, "src"), sourcefile: "mcp-reference-entry.ts", loader: "ts" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    write: false,
    logLevel: "silent",
  });
  const dir = mkdtempSync(path.join(tmpdir(), "mcp-reference-"));
  const file = path.join(dir, "server.mjs");
  try {
    writeFileSync(file, result.outputFiles[0].text);
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const STUB_API_URL = "http://127.0.0.1:9/api";
const STUB_USER_ID = "00000000-0000-4000-8000-000000000000";

/**
 * The connection shapes a server can be started in, and what each stands for.
 * `key` is the credential *kind* (src/config.ts routes on its prefix), not a
 * credential: nothing here reaches a server.
 */
export const CONNECTIONS = [
  { id: "setup", toolset: "setup", key: "pcp_reference", agentId: null, label: "`AGENTDASH_TOOLSET=setup`, not scoped to an agent" },
  { id: "setup-agent", toolset: "setup", key: "pcp_reference", agentId: STUB_USER_ID, label: "`AGENTDASH_TOOLSET=setup` with `PAPERCLIP_AGENT_ID` set" },
  { id: "agent", toolset: "agent", key: "pcp_reference", agentId: null, label: "`agent` (the default), not scoped to an agent" },
  { id: "agent-agent", toolset: "agent", key: "pcp_reference", agentId: STUB_USER_ID, label: "`agent` with `PAPERCLIP_AGENT_ID` set — also every `POST /api/mcp` connection, which takes the agent from the key" },
  { id: "assistant", toolset: "assistant", key: "pcpa_reference", agentId: null, label: "`assistant` (stdio, or `POST /api/mcp/assistant`)" },
  { id: "human", toolset: "human", key: "pcp_board_reference", agentId: null, label: "`human` (board key, stdio only)" },
  { id: "bridge", toolset: "agent", key: "bridge-endpoint-reference", agentId: null, label: "a bridge endpoint token (any toolset except `human`)" },
  { id: "bridge-agent", toolset: "agent", key: "bridge-endpoint-reference", agentId: STUB_USER_ID, label: "a bridge endpoint token with `PAPERCLIP_AGENT_ID` set" },
];

/** fetch, replaced: the human identity probe gets an answer, anything else is a bug. */
function installFetchStub() {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${STUB_API_URL}/human-control/identity`) {
      return new Response(JSON.stringify({ source: "board_key", user: { id: STUB_USER_ID }, targets: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`generate-mcp-reference: unexpected network request to ${url}; listing must not need the API`);
  };
  return () => {
    globalThis.fetch = original;
  };
}

async function listConnection(mod, connection, extra = {}) {
  const server = mod.createAgentDashServer(
    {
      apiUrl: STUB_API_URL,
      apiKey: connection.key,
      companyId: null,
      agentId: connection.agentId,
      runId: null,
      ...extra,
    },
    { toolset: connection.toolset },
  );
  const client = new mod.Client({ name: "agentdash-docs-generator", version: "0.0.0" });
  const [clientTransport, serverTransport] = mod.InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    const { resources } = await client.listResources();
    const { resourceTemplates } = await client.listResourceTemplates();
    return { tools, resources, resourceTemplates, instructions: client.getInstructions() ?? "" };
  } finally {
    await client.close();
    await server.close();
  }
}

/** Everything the pages are made of, read from a running server. */
export async function readMcpSurface(repoRoot) {
  const mod = await loadServerModule(repoRoot);
  const restore = installFetchStub();
  try {
    const connections = {};
    for (const connection of CONNECTIONS) connections[connection.id] = await listConnection(mod, connection);
    const assistant = connections.assistant;
    const byScopes = async (scopes) =>
      (await listConnection(mod, CONNECTIONS.find((c) => c.id === "assistant"), { assistantScopes: scopes })).tools.map((t) => t.name);
    const readOnly = await byScopes([mod.ASSISTANT_SCOPE_READ]);
    const withWork = await byScopes([mod.ASSISTANT_SCOPE_READ, mod.ASSISTANT_SCOPE_WORK]);
    const withDecide = await byScopes([mod.ASSISTANT_SCOPE_READ, mod.ASSISTANT_SCOPE_DECIDE]);
    const assistantScopeOf = new Map();
    for (const tool of assistant.tools) {
      if (readOnly.includes(tool.name)) assistantScopeOf.set(tool.name, mod.ASSISTANT_SCOPE_READ);
      else if (withWork.includes(tool.name)) assistantScopeOf.set(tool.name, mod.ASSISTANT_SCOPE_WORK);
      else if (withDecide.includes(tool.name)) assistantScopeOf.set(tool.name, mod.ASSISTANT_SCOPE_DECIDE);
      else throw new Error(`assistant tool ${tool.name} is in no scope's surface`);
    }
    return {
      connections,
      toolsets: [...mod.AGENTDASH_TOOLSETS],
      assistantScopeOf,
      scopes: { read: mod.ASSISTANT_SCOPE_READ, work: mod.ASSISTANT_SCOPE_WORK, decide: mod.ASSISTANT_SCOPE_DECIDE },
      playbooks: [
        { name: "PLAYBOOK", file: "packages/mcp-server/src/playbook.ts", text: mod.PLAYBOOK },
        { name: "STEWARD_PLAYBOOK", file: "packages/mcp-server/src/playbook.ts", text: mod.STEWARD_PLAYBOOK },
        { name: "ASSISTANT_PLAYBOOK", file: "packages/mcp-server/src/playbook.ts", text: mod.ASSISTANT_PLAYBOOK },
        { name: "HUMAN_PLAYBOOK", file: "packages/mcp-server/src/human.ts", text: mod.HUMAN_PLAYBOOK },
      ],
    };
  } finally {
    restore();
  }
}

// ---------------------------------------------------------------------------
// What stays off the public site
// ---------------------------------------------------------------------------

/**
 * Client and engagement names stay off the public site
 * (doc/plans/2026-10-01-public-docs-section.md, "Content rules"). Two kinds of
 * text in the server carry one:
 *
 *  - Engagement-specific tools. A tool name cannot be relabeled, so a tool
 *    whose name matches ENGAGEMENT_PATTERN is left out of its page, and the
 *    page header says how many were.
 *  - Engagement-specific playbook guidance. A playbook `## ` section whose
 *    heading or body matches is left out of playbooks.md, whole; the sections
 *    kept are quoted byte for byte, and the header says how many were left out.
 *
 * The pattern is the name as a word: `Ross`, `ross-review`,
 * `request_ross_assessment`, `rossEvidence` match; `across` and `gross` do
 * not. Anything that still matches after omission fails generation
 * (assertNothingPrivate), so a new mention elsewhere is caught here rather
 * than published.
 */
export const ENGAGEMENT_PATTERN = /(?<![A-Za-z])[Rr]oss(?![a-z])|execos/i;

/** An enum or const value named after an engagement (PR 3b review): left out of the input tables. */
export function isEngagementValue(value) {
  return typeof value === "string" && ENGAGEMENT_PATTERN.test(value);
}
export const OMITTED_REASON = "engagement-specific";

export function omitEngagementTools(tools) {
  const kept = tools.filter((tool) => !ENGAGEMENT_PATTERN.test(tool.name));
  return { kept, omitted: tools.length - kept.length };
}

/** A playbook split at its `## ` headings; the text before the first one is a section too. */
export function playbookSections(text) {
  const sections = [];
  let current = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("## ") && current.length > 0) {
      sections.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  sections.push(current.join("\n"));
  return sections;
}

/** The playbook with every engagement-specific section left out, and how many were. */
export function omitEngagementSections(text) {
  const sections = playbookSections(text);
  const kept = sections.filter((section) => !ENGAGEMENT_PATTERN.test(section));
  return { text: kept.join("\n"), omitted: sections.length - kept.length };
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function omissionNote(count, noun) {
  return `> ${plural(count, noun)} omitted: ${OMITTED_REASON}.`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** One table cell: one line, pipes escaped. */
export function cell(text) {
  return String(text ?? "")
    .replace(/\s*\r?\n\s*/g, " ")
    .replace(/\|/g, "\\|")
    .trim();
}

function literal(value) {
  return `\`${JSON.stringify(value)}\``;
}

/** A JSON schema's type, compactly: `string`, `"a" \| "b"`, `array of object`, `string \| null`. */
export function schemaType(schema) {
  if (!schema || typeof schema !== "object") return "any";
  if ("const" in schema) {
    if (isEngagementValue(schema.const)) return `string (1 value omitted: ${OMITTED_REASON})`;
    return literal(schema.const);
  }
  if (Array.isArray(schema.enum)) {
    // A private profile's value is left out, not relabeled: nobody outside
    // that profile can send it, so it is not a choice a reader has. An
    // engagement's value is left out the same way, and says so.
    const values = schema.enum.filter(
      (value) => !(typeof value === "string" && isPrivateProfile(value)) && !isEngagementValue(value),
    );
    const omitted = schema.enum.length - values.length;
    const engagement = schema.enum.some(isEngagementValue);
    const listed = values.map((value) => literal(value)).join(" | ");
    if (omitted === 0) return listed;
    return `${listed || "string"} (${plural(omitted, "value")} omitted${engagement ? `: ${OMITTED_REASON}` : ""})`;
  }
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union)) {
    const objectForms = union.filter((option) => option?.type === "object" && option.properties).length;
    const parts = [];
    for (const option of union) {
      // Two or more object forms (a discriminated union) are told apart by their fields, so show them.
      const rendered = objectForms > 1 && option?.type === "object" && option.properties ? objectSignature(option) : schemaType(option);
      if (!parts.includes(rendered)) parts.push(rendered);
    }
    return parts.join(" | ");
  }
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  switch (schema.type) {
    case "array":
      return `array of ${schemaType(schema.items)}`;
    case "object":
      if (schema.additionalProperties && typeof schema.additionalProperties === "object" && !schema.properties) {
        return `map of ${schemaType(schema.additionalProperties)}`;
      }
      return "object";
    case "string":
      return schema.format ? `string (${schema.format})` : "string";
    case undefined:
      return "any";
    default:
      return String(schema.type);
  }
}

/** `{ kind: "company", companyId: string (uuid) }` — an object form on one line; `?` marks optional fields. */
export function objectSignature(schema) {
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields = Object.entries(schema.properties ?? {}).map(
    ([name, property]) => `${name}${required.has(name) ? "" : "?"}: ${schemaType(property)}`,
  );
  return `{ ${fields.join(", ")} }`;
}

/** The object schema nested in `schema`, if a row should expand into its properties. */
function nestedObject(schema) {
  if (!schema || typeof schema !== "object") return null;
  if (schema.type === "object" && schema.properties && Object.keys(schema.properties).length > 0) return { schema, suffix: "" };
  if (schema.type === "array" && schema.items?.type === "object" && schema.items.properties) {
    return { schema: schema.items, suffix: "[]" };
  }
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union)) {
    const objects = union.filter((option) => option?.type !== "null");
    if (objects.length === 1) return nestedObject(objects[0]);
  }
  return null;
}

const CONSTRAINTS = [
  ["minLength", "Minimum length"],
  ["maxLength", "Maximum length"],
  ["minimum", "Minimum"],
  ["maximum", "Maximum"],
  ["exclusiveMinimum", "Exclusive minimum"],
  ["exclusiveMaximum", "Exclusive maximum"],
  ["minItems", "Minimum items"],
  ["maxItems", "Maximum items"],
];

function rowDescription(schema) {
  const parts = [];
  if (schema?.description) parts.push(schema.description);
  if (schema && "default" in schema) parts.push(`Default: ${literal(schema.default)}.`);
  for (const [key, label] of CONSTRAINTS) {
    if (schema && typeof schema[key] === "number") parts.push(`${label}: ${schema[key]}.`);
  }
  return parts.join(" ");
}

/** Rows for an object schema's properties, nested objects flattened as `a.b` and `a[].b`. */
export function propertyRows(schema, prefix = "") {
  const rows = [];
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  for (const [name, property] of Object.entries(schema?.properties ?? {})) {
    const key = `${prefix}${name}`;
    rows.push({ property: key, type: schemaType(property), required: required.has(name), description: rowDescription(property) });
    const nested = nestedObject(property);
    if (nested) rows.push(...propertyRows(nested.schema, `${key}${nested.suffix}.`));
  }
  return rows;
}

/** The input schema as a table, or a sentence when there is nothing to fill in. */
export function inputTable(inputSchema) {
  const union = inputSchema?.anyOf ?? inputSchema?.oneOf;
  if (!inputSchema?.properties && Array.isArray(union)) {
    return union
      .map((variant, index) => `Input, form ${index + 1} of ${union.length}:\n\n${inputTable(variant)}`)
      .join("\n\n");
  }
  const rows = propertyRows(inputSchema);
  if (rows.length === 0) return "No input.";
  return [
    "| Property | Type | Required | Description |",
    "|---|---|---|---|",
    ...rows.map((row) => `| \`${cell(row.property)}\` | ${cell(row.type)} | ${row.required ? "yes" : "no"} | ${cell(row.description)} |`),
  ].join("\n");
}

function annotationsLine(annotations) {
  if (!annotations) return null;
  const parts = Object.keys(annotations)
    .sort()
    .map((key) => `\`${key}: ${JSON.stringify(annotations[key])}\``);
  return parts.length > 0 ? `Annotations: ${parts.join(", ")}.` : null;
}

function frontMatter(title, summary) {
  return ["---", `title: ${JSON.stringify(title)}`, `summary: ${JSON.stringify(summary)}`, "---", ""].join("\n");
}

function header(commit, lines, notes = []) {
  return [
    `> Generated at commit \`${commit}\` by \`${GENERATOR_REL}\`.`,
    "> Do not edit this page: run `pnpm docs:mcp-reference` instead. CI fails when it is stale.",
    ...notes,
    "",
    ...lines,
    "",
  ].join("\n");
}

function renderTool(tool, level = "##") {
  const out = [`${level} \`${tool.name}\``, "", tool.description?.trim() || "_No description._", ""];
  const annotations = annotationsLine(tool.annotations);
  const notes = [...(annotations ? [annotations] : []), ...(tool.outputSchema ? ["Declares an output schema."] : [])];
  if (notes.length > 0) out.push(notes.join(" "), "");
  out.push(inputTable(tool.inputSchema), "");
  return out.join("\n");
}

const SURFACE_TEXT = {
  setup: {
    summary: "The install and onboarding tools: what an agent standing up a fresh instance is given.",
    source: "`buildToolSurface(client, config, \"setup\")` in `packages/mcp-server/src/index.ts`; the tools are defined in `src/journey.ts`",
    connection: "setup",
  },
  agent: {
    summary: "The control-plane toolset: the default for stdio and the only one `POST /api/mcp` serves.",
    source: "`buildToolSurface(client, config, \"agent\")` in `packages/mcp-server/src/index.ts`; the tools are defined in `src/tools.ts`, `src/journey.ts` and `src/harness.ts`, in that order",
    connection: "agent",
  },
  assistant: {
    summary: "The person-facing toolset a cloud assistant relays to a person, filtered by the grant's OAuth scopes.",
    source: "`buildToolSurface(client, config, \"assistant\")` in `packages/mcp-server/src/index.ts`; the tools are defined in `src/assistant/tools.ts`, `src/assistant/work.ts` and `src/assistant/gated.ts`",
    connection: "assistant",
  },
  human: {
    summary: "The trusted-local-human toolset: the signed-in person's own board key, over stdio.",
    source: "`buildToolSurface(client, config, \"human\")` in `packages/mcp-server/src/index.ts`; the tools are defined in `src/human.ts`, their input schemas in `packages/shared/src/validators/human-control.ts`",
    connection: "human",
  },
  bridge: {
    summary: "The tools a bridge endpoint token gets: the local end of the agent bridge and the steward inbox.",
    source: "`buildToolSurface` in `packages/mcp-server/src/index.ts`, which returns these for any credential `isControlPlaneCredential` (`src/config.ts`) rejects, whatever the toolset except `human`; the tools are defined in `src/bridge.ts`",
    connection: "bridge",
  },
};

const ASSISTANT_SCOPE_HEADINGS = (scopes) => [
  { scope: scopes.read, heading: `Read tools — every grant (\`${scopes.read}\`)` },
  { scope: scopes.work, heading: `Work tools — grants with \`${scopes.work}\`` },
  { scope: scopes.decide, heading: `Gated tools — grants with \`${scopes.decide}\`` },
];

export function renderToolPage(page, surface, commit) {
  const text = SURFACE_TEXT[page.surface];
  const listed = surface.connections[text.connection].tools;
  const { kept: tools, omitted } = omitEngagementTools(listed);
  const notes = omitted > 0 ? [omissionNote(omitted, "tool")] : [];
  const lines = [
    `**${listed.length} tools** — measured: the length of the \`tools/list\` response` +
      (omitted > 0 ? `; ${tools.length} are documented here and ${omitted} ${omitted === 1 ? "is" : "are"} omitted as ${OMITTED_REASON}` : "") +
      `. Source: ${text.source}.`,
    "",
    "Each tool's description is its inline string, verbatim. The input table is rendered from the JSON schema the server advertises in `tools/list`" +
      (page.surface === "human"
        ? " (`humanJsonSchema` from `packages/shared/src/validators/human-control.ts`, as `src/index.ts` uses for this toolset)."
        : " (`toolInputSchema` in `packages/mcp-server/src/schema.ts`, converted from the tool's zod schema).") +
      " Nested objects are flattened: `a.b` is property `b` of object `a`, and `a[].b` is property `b` of each item of array `a`.",
  ];
  const sections = [];
  if (page.surface === "assistant") {
    lines.push(
      "",
      "Over `POST /api/mcp/assistant` the grant's scopes filter this list (`src/assistant/index.ts`): the read tools are always served, the work tools only with " +
        `\`${surface.scopes.work}\`, the gated tools only with \`${surface.scopes.decide}\`. Over stdio no scopes apply and all ${listed.length} are served. ` +
        "Which tool needs which scope is measured by listing the surface with each scope set.",
    );
    for (const { scope, heading } of ASSISTANT_SCOPE_HEADINGS(surface.scopes)) {
      const group = tools.filter((tool) => surface.assistantScopeOf.get(tool.name) === scope);
      const groupOmitted = listed.filter((tool) => surface.assistantScopeOf.get(tool.name) === scope).length - group.length;
      sections.push(`## ${heading}\n\n${plural(group.length, "tool")}${groupOmitted > 0 ? `; ${groupOmitted} omitted: ${OMITTED_REASON}` : ""}.\n`);
      for (const tool of group) sections.push(renderTool(tool, "###"));
    }
  } else {
    for (const tool of tools) sections.push(renderTool(tool));
  }
  lines.push("", `Tools${omitted > 0 ? " documented here" : ""}, in the order \`tools/list\` returns them: ${tools.map((tool) => `\`${tool.name}\``).join(", ")}.`);
  return `${frontMatter(page.title, text.summary)}\n${header(commit, lines, notes)}\n${sections.join("\n")}`.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** Which connections are given what, as "label" lists. */
function servedBy(surface, pick) {
  return CONNECTIONS.filter((connection) => pick(surface.connections[connection.id])).map((connection) => connection.label);
}

/** The surfaces a resource is listed on. Connection shapes of one surface must agree, or this throws. */
const SURFACE_CONNECTIONS = {
  setup: ["setup", "setup-agent"],
  agent: ["agent", "agent-agent"],
  assistant: ["assistant"],
  human: ["human"],
  bridge: ["bridge", "bridge-agent"],
};
function servedToSurfaces(surface, pick, what) {
  const out = [];
  for (const [name, ids] of Object.entries(SURFACE_CONNECTIONS)) {
    const answers = ids.map((id) => Boolean(pick(surface.connections[id])));
    if (answers.some((answer) => answer !== answers[0])) {
      throw new Error(`${what}: the ${name} connection shapes disagree; describe them separately`);
    }
    if (answers[0]) out.push(`[${name}](/mcp/tools/${name})`);
  }
  return out.length > 0 ? out.join(", ") : "none";
}

export function renderResourcesPage(surface, commit) {
  const all = surface.connections.agent;
  const lines = [
    "Measured: `resources/list` and `resources/templates/list` against a server started in each connection shape. \"Listed on\" names the toolsets whose listing includes the resource. The read handler is in `packages/mcp-server/src/index.ts`; the descriptions and the derivation templates are in `src/resources.ts`. On the assistant and human toolsets a read of anything other than `agentdash://playbook` fails (`src/index.ts`).",
  ];
  const sections = ["## Resources", ""];
  for (const resource of all.resources) {
    sections.push(
      `### \`${resource.uri}\``,
      "",
      resource.description ?? "",
      "",
      `Name: ${resource.name}. MIME type: \`${resource.mimeType}\`.`,
      "",
      `Listed on: ${servedToSurfaces(surface, (listing) => listing.resources.some((r) => r.uri === resource.uri), resource.uri)}.`,
      "",
    );
  }
  sections.push("## Resource templates", "");
  for (const template of all.resourceTemplates) {
    sections.push(
      `### \`${template.uriTemplate}\``,
      "",
      template.description ?? "",
      "",
      `Name: ${template.name}. MIME type: \`${template.mimeType}\`.`,
      "",
      `Listed on: ${servedToSurfaces(surface, (listing) => listing.resourceTemplates.some((t) => t.uriTemplate === template.uriTemplate), template.uriTemplate)}.`,
      "",
    );
  }
  return `${frontMatter("Resources", "The agentdash:// resources and resource templates the MCP server lists, and to whom.")}\n${header(commit, lines)}\n${sections.join("\n")}`
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd() + "\n";
}

/** A fence longer than any backtick run in `text`, so the text is quoted byte for byte. */
function fenceFor(text) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(longest + 1);
}

export function renderPlaybooksPage(surface, commit) {
  const lines = [
    "A playbook is the operating contract a connected harness is given: the server sends it as the MCP `instructions` string when the session starts, and serves the same text as the `agentdash://playbook` resource. There are four, one per kind of caller. `selectPlaybook` in `packages/mcp-server/src/playbook.ts` picks among the first three; the human toolset always gets the fourth (`src/index.ts`).",
    "",
    "Each is quoted verbatim from its constant, except that a section of engagement-specific guidance is left out whole; the page header and the playbook's own line say how many. \"Served to\" is measured: the `instructions` a server started in each connection shape actually sent.",
  ];
  const sections = [];
  let omittedTotal = 0;
  for (const playbook of surface.playbooks) {
    const served = servedBy(surface, (listing) => listing.instructions === playbook.text);
    if (served.length === 0) throw new Error(`${playbook.name} is served to no connection shape`);
    const { text, omitted } = omitEngagementSections(playbook.text);
    omittedTotal += omitted;
    const fence = fenceFor(text);
    sections.push(
      `## \`${playbook.name}\``,
      "",
      `Defined in \`${playbook.file}\`. Served to: ${served.join("; ")}.` +
        (omitted > 0 ? ` ${plural(omitted, "section")} omitted: ${OMITTED_REASON}.` : ""),
      "",
      `${fence}markdown`,
      text.replace(/\n+$/, ""),
      fence,
      "",
    );
  }
  for (const connection of CONNECTIONS) {
    const instructions = surface.connections[connection.id].instructions;
    if (!surface.playbooks.some((playbook) => playbook.text === instructions)) {
      throw new Error(`connection ${connection.id} was sent instructions that match no playbook constant`);
    }
  }
  return `${frontMatter("Playbooks", "The four operating contracts the MCP server sends as its instructions, verbatim, and which connection gets which.")}\n${header(commit, lines, omittedTotal > 0 ? [omissionNote(omittedTotal, "section")] : [])}\n${sections.join("\n")}`
    .trimEnd() + "\n";
}

/**
 * packages/connect/README.md as a docs page. The README is the one source: it
 * is what npm shows, and this page is a copy with front matter in place of the
 * README's own first heading.
 */
export function renderConnectPage(readme, commit) {
  const match = /^# (.+)\r?\n/.exec(readme);
  if (!match) throw new Error(`${CONNECT_README_REL} must start with a "# " heading`);
  const body = readme.slice(match[0].length).replace(/^\s+/, "");
  const page = [
    frontMatter(match[1].trim(), "Connect Claude Code or Codex on your machine to your AgentDash agent."),
    `> Generated at commit \`${commit}\` by \`${GENERATOR_REL}\`.`,
    `> This page is \`${CONNECT_README_REL}\`, the README published to npm with the package. Edit the README, then run \`pnpm docs:mcp-reference\`.`,
    "",
    body.trimEnd(),
    "",
  ];
  return page.join("\n");
}

function gitCommit(repoRoot) {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    return /^[0-9a-f]{4,40}$/.test(sha) ? sha : "0000000";
  } catch {
    return "0000000";
  }
}

/**
 * The one change made to the server's text. The name of a client's product
 * profile is not public (doc/plans/2026-10-01-public-docs-section.md, decision
 * 3), and a few tool descriptions and one enum carry it. Those places are
 * rewritten to PRIVATE_PROFILE_LABEL and the page says how many there were, so
 * the pages stay verbatim everywhere else and say so where they are not. The
 * docs forbidden-token scan (ui/src/lib/docs.test.ts) enforces the result.
 */
export const PRIVATE_PROFILE_PATTERN = /agentdash[\s_-]?mk/gi;

/** Whether `value` is, or names, the private profile (non-global, so no lastIndex state). */
export function isPrivateProfile(value) {
  return new RegExp(PRIVATE_PROFILE_PATTERN.source, "i").test(value);
}
export const PRIVATE_PROFILE_LABEL = "[private profile]";

export function redactPrivateProfile(content) {
  const count = (content.match(PRIVATE_PROFILE_PATTERN) ?? []).length;
  if (count === 0) return content;
  const redacted = content.replace(PRIVATE_PROFILE_PATTERN, PRIVATE_PROFILE_LABEL);
  const note =
    `> Verbatim except for one substitution, in ${count} ${count === 1 ? "place" : "places"}: ` +
    `the name of a product profile that is not public is shown as \`${PRIVATE_PROFILE_LABEL}\`.`;
  const lines = redacted.split("\n");
  const at = lines.findIndex((line) => COMMIT_LINE.test(line));
  if (at === -1) throw new Error("redactPrivateProfile: no header to annotate");
  lines.splice(at + 1, 0, note);
  return lines.join("\n");
}

/** Fails generation when an engagement name survived omission. */
export function assertNothingPrivate(rel, content) {
  const match = ENGAGEMENT_PATTERN.exec(content);
  if (match) {
    const line = content.slice(0, match.index).split("\n").length;
    throw new Error(`${rel}:${line} still names an engagement after omission; extend the omission rules in ${GENERATOR_REL}`);
  }
}

/** Every generated file: repo-relative path → content. */
export async function generateMcpReference(repoRoot, { commit = gitCommit(repoRoot) } = {}) {
  const surface = await readMcpSurface(repoRoot);
  const files = new Map();
  for (const page of TOOL_PAGES) files.set(page.rel, renderToolPage(page, surface, commit));
  files.set(RESOURCES_REL, renderResourcesPage(surface, commit));
  files.set(PLAYBOOKS_REL, renderPlaybooksPage(surface, commit));
  files.set(CONNECT_PAGE_REL, renderConnectPage(readFileSync(path.join(repoRoot, CONNECT_README_REL), "utf8"), commit));
  for (const [rel, content] of files) files.set(rel, redactPrivateProfile(content));
  for (const [rel, content] of files) assertNothingPrivate(rel, content);
  return files;
}

/**
 * Write `files` under `outRoot`. A file whose only change would be the commit
 * line is left alone, so a rerun on an unchanged source is a no-op.
 */
export function writeGenerated(files, outRoot) {
  const written = [];
  for (const [rel, next] of files) {
    const target = path.join(outRoot, rel);
    const current = existsSync(target) ? readFileSync(target, "utf8") : null;
    if (current !== null && withoutCommitLine(current) === withoutCommitLine(next)) continue;
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, next);
    written.push(rel);
  }
  return written;
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const files = await generateMcpReference(repoRoot);
  const written = writeGenerated(files, repoRoot);
  for (const rel of GENERATED_FILES) console.log(`${written.includes(rel) ? "Wrote" : "Unchanged"} ${rel}.`);
}

// Entry guard: resolve symlinks on both sides (scripts/entry-guard.test.mjs; cf. #666).
function realOrResolved(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
if (process.argv[1] && realOrResolved(process.argv[1]) === realOrResolved(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
