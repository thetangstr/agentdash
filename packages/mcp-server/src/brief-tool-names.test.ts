import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { bridgeTools } from "./bridge.js";
import { PaperclipApiClient } from "./client.js";
import { harnessTools } from "./harness.js";
import { createJourneyToolDefinitions } from "./journey.js";
import { createToolDefinitions } from "./tools.js";

/**
 * The handoff brief in `scripts/demo/first-run.mjs` names MCP tools by hand, and
 * a name that does not exist is the worst kind of instruction: the person
 * following it cannot tell whether they mistyped it, whether their connection is
 * broken, or whether the brief is simply wrong.
 *
 * Four calls in that brief were already wrong once — a missing `pipelineId`, a
 * `sourceKind` outside its enum, an invite field that does not exist, and a step
 * with no endpoint at all — and every one was prose drifting from an API nobody
 * re-read. `verify-handoff.mjs` catches that for the HTTP calls by executing them.
 * This catches it for the tool names, which no HTTP check can see.
 *
 * It reads the brief rather than duplicating a list, so a tool renamed here or a
 * name invented there both fail loudly.
 */

const CONFIG = {
  apiUrl: "http://localhost:3100/api",
  apiKey: "token-123",
  companyId: null,
  agentId: null,
  runId: null,
};

const client = new PaperclipApiClient(CONFIG);
const toolNames = new Set(
  [
    ...createToolDefinitions(client),
    ...createJourneyToolDefinitions(client),
    ...bridgeTools(client),
    ...harnessTools(client),
  ].map((tool) => tool.name),
);

const briefPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/demo/first-run.mjs",
);
const brief = readFileSync(briefPath, "utf8");

/**
 * Every identifier in the brief that looks like one of our tool names. Matching
 * on the prefixes rather than a hand-kept list is the point: it cannot fall out
 * of date with the brief.
 */
const cited = [...new Set(brief.match(/\b(?:paperclip|agentdash)[A-Za-z_]{3,}\b/g) ?? [])]
  // `agentdash` also appears in package names, URLs and prose ("agentdash_mk",
  // "agentdash-mcp-server"), so keep only things shaped like a tool identifier.
  .filter((name) => toolNames.has(name) || /^(paperclip|agentdash)[A-Z]/.test(name));

describe("the handoff brief only names tools that exist", () => {
  it("cites at least a few tools, so the extraction cannot silently match nothing", () => {
    // Guards the guard: if the regex stops matching, every assertion below would
    // pass on an empty list and the check would quietly stop protecting anything.
    expect(cited.length).toBeGreaterThanOrEqual(4);
  });

  it.each(cited.map((name) => [name]))("%s is a real tool", (name: string) => {
    expect(toolNames.has(name), `the brief names "${name}" but no such tool exists`).toBe(true);
  });

  /**
   * The distinction that would otherwise be invisible. `agentdashPushAgentDirectives`
   * writes to a separate steward-provenance store; only AGENTS.md is read as the
   * agent's system prompt. A mandate pushed as directives would look saved and
   * change nothing about how the agent answers, so the brief has to say which one
   * it means.
   */
  it("warns that directives are not the mandate", () => {
    expect(brief).toContain("Write AGENTS.md, not directives");
    expect(brief).toContain("agentdashPushAgentDirectives");
  });

  it("tells the harness not to bind itself to a single agent while building", () => {
    // With PAPERCLIP_AGENT_ID set, the MCP serves the steward playbook — the
    // contract for one agent doing its own work, not for provisioning a company.
    expect(brief).toContain("Do NOT set PAPERCLIP_AGENT_ID here");
  });

  it("names the agent-only routes the owner's connection cannot reach", () => {
    // Fact-request escalate/answer are agent-authenticated. The owner's key gets
    // 403, correctly, and a brief that did not say so would read as a bug.
    expect(brief).toContain("x-agent-key");
    expect(brief).toMatch(/agent-only/i);
  });
});
