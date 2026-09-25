/**
 * AgentDash MCP Server
 *
 * One unified server exposing two toolsets over the AgentDash / Paperclip
 * control-plane API:
 *
 *  - paperclip*  — zod-validated control-plane tools (issues, comments,
 *    documents, agents, approvals, workspaces) from src/tools.ts
 *  - agentdash_* — the launch journey (install checklist → deep-interview
 *    onboarding → provisioning → self-driving operation with human-approval
 *    gates) from src/journey.ts
 *
 * The operating contract the calling agent follows lives in src/playbook.ts
 * and is served both as the server `instructions` and as the
 * `agentdash://playbook` resource.
 *
 * Config comes from PAPERCLIP_* env vars, with AGENTDASH_* accepted as
 * aliases (see src/config.ts). Entry point for stdio transport: src/stdio.ts.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { PaperclipApiClient } from "./client.js";
import {
  isControlPlaneCredential,
  readConfigFromEnv,
  type PaperclipMcpConfig,
} from "./config.js";
import { createJourneyToolDefinitions } from "./journey.js";
import { bridgeTools } from "./bridge.js";
import { harnessTools } from "./harness.js";
import { createAssistantToolDefinitions } from "./assistant/index.js";
import { selectPlaybook } from "./playbook.js";
import { RESOURCE_TEMPLATES, listResources, readAgentDashResource } from "./resources.js";
import { toolInputSchema } from "./schema.js";
import { createToolDefinitions, type ToolDefinition } from "./tools.js";

export const SERVER_NAME = "agentdash";
export const SERVER_VERSION = "0.3.0";

/**
 * AgentDash assistant MCP (spec §4.3): which of the server's toolsets to
 * expose. `agent` is the long-standing control-plane surface; `setup` is the
 * install/onboarding runbook an agent standing up a fresh instance follows;
 * `assistant` is the nine person-facing read tools (M1) a cloud assistant
 * relays to a person. stdio picks via AGENTDASH_TOOLSET; /api/mcp stays
 * `agent`.
 */
export type AgentDashToolset = "setup" | "agent" | "assistant";

export const AGENTDASH_TOOLSETS: readonly AgentDashToolset[] = ["setup", "agent", "assistant"];

export function parseToolset(raw: string | undefined | null): AgentDashToolset {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return "agent";
  if ((AGENTDASH_TOOLSETS as readonly string[]).includes(normalized)) {
    return normalized as AgentDashToolset;
  }
  throw new Error(`Unknown AGENTDASH_TOOLSET "${raw}" (expected ${AGENTDASH_TOOLSETS.join(", ")})`);
}

/**
 * The tools this credential can actually use.
 *
 * A bridge endpoint token authenticates the bridge tools and nothing else, so a
 * steward's own Claude Code is offered only those. Advertising the whole
 * control plane to a credential that cannot reach it produces 403s that read as
 * a broken instance rather than the wrong credential.
 *
 * Exported so the surface can be asserted directly. It was previously inlined,
 * and the only test possible was that the server object existed.
 */
export function buildToolSurface(
  client: PaperclipApiClient,
  config: PaperclipMcpConfig,
  toolset: AgentDashToolset = "agent",
): ToolDefinition[] {
  if (!isControlPlaneCredential(config.apiKey)) return [...bridgeTools(client)];
  // No bridge tools on a control-plane credential — the exclusion cuts BOTH
  // ways. Every /bridge/* route requires a bridge-endpoint actor, so each of
  // these tools answered an agent key with 403 "Bridge endpoint authentication
  // required"; a steward counted all eight in tools/list and reasonably read
  // the failures as a broken instance. And the separation is deliberate, not
  // incidental: the inbox is the STEWARD's — it carries their approvals and
  // delivers their decision handles — so an agent's own credential must never
  // reach it even if the routes could be widened. bridge.ts says the same from
  // the other side: the endpoint token "is deliberately NOT an AgentDash API
  // key". Two credentials, two surfaces, no overlap.
  switch (toolset) {
    case "setup":
      return [...createJourneyToolDefinitions(client)];
    case "assistant":
      return createAssistantToolDefinitions(client, config);
    case "agent":
    default:
      return [
        ...createToolDefinitions(client),
        ...createJourneyToolDefinitions(client),
        ...harnessTools(client),
      ];
  }
}

export function createAgentDashServer(
  config: PaperclipMcpConfig,
  options: { toolset?: AgentDashToolset } = {},
): Server {
  const client = new PaperclipApiClient(config);
  /**
   * A bridge endpoint token authenticates the bridge tools and nothing else, so
   * a steward's own Claude Code is offered only those. Advertising the whole
   * control plane to a credential that cannot reach it produces 403s that read
   * as a broken instance instead of the wrong credential.
   *
   * The control-plane toolset stays the default, including for an empty key: a
   * fresh install has none yet and bootstraps one through the signup tools.
   */
  const toolset = options.toolset ?? "agent";
  const tools = buildToolSurface(client, config, toolset);
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { resources: {}, tools: {} },
      // Scoped to one agent → that agent's own contract; otherwise the
      // operator's. Serving the operator's playbook to a person's harness tells
      // it to go provision a company instead of doing the work it was given.
      // The assistant toolset gets its own contract: relaying to a person,
      // not doing the work.
      instructions: selectPlaybook({ agentId: config.agentId, toolset }),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: toolInputSchema(tool.schema),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolsByName.get(name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Error: unknown tool ${name}` }],
        isError: true,
      };
    }
    return tool.execute(args ?? {});
  });

  const appBaseUrl = config.apiUrl.replace(/\/api$/, "");

  // AgentDash GH #676: the assistant toolset serves no raw resources. The
  // static agent/task URIs and the derivation record are control-plane data —
  // adapter config, budgets, mandates — which the person-facing contract
  // forbids on this surface. Only the playbook survives: it is the contract
  // the assistant is supposed to read. Listings advertise nothing else and
  // reads of anything else fail closed.
  const assistantOnly = toolset === "assistant";
  const resources = assistantOnly
    ? listResources().filter((resource) => resource.uri === "agentdash://playbook")
    : listResources();

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources }));

  /**
   * AgentDash-MK: the derivation record.
   *
   * Templates rather than fixed URIs, because the interesting resource is "this
   * figure" and there is one per fact. Read-only shared context: nothing
   * verifies that a harness read any of it, and the descriptions say so.
   */
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: assistantOnly ? [] : RESOURCE_TEMPLATES.map((template) => ({ ...template })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (assistantOnly && uri !== "agentdash://playbook") {
      throw new Error(`Resource not available in the assistant toolset: ${uri}`);
    }
    // Tried first, and returns null for anything it does not own, so the static
    // resources below are unchanged by its existence.
    const derivation = await readAgentDashResource(client, { companyId: config.companyId }, uri);
    if (derivation) return derivation;
    if (uri === "agentdash://playbook") {
      return {
        contents: [{ uri, mimeType: "text/markdown", text: selectPlaybook({ agentId: config.agentId, toolset }) }],
      };
    }
    if (uri === "agentdash://dashboard") {
      return {
        contents: [{ uri, mimeType: "text/plain", text: appBaseUrl }],
      };
    }
    if (uri === "agentdash://agents") {
      const companyId = config.companyId;
      if (!companyId) {
        return {
          contents: [{
            uri,
            mimeType: "application/json",
            text: JSON.stringify({ hint: "Set PAPERCLIP_COMPANY_ID (or AGENTDASH_COMPANY_ID), or use the agentdash_list_agents tool with a companyId" }),
          }],
        };
      }
      const agents = await client.requestJson("GET", `/companies/${companyId}/agents`);
      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify(agents, null, 2) }],
      };
    }
    if (uri === "agentdash://tasks") {
      const companyId = config.companyId;
      if (!companyId) {
        return {
          contents: [{
            uri,
            mimeType: "application/json",
            text: JSON.stringify({ hint: "Set PAPERCLIP_COMPANY_ID (or AGENTDASH_COMPANY_ID), or use the agentdash_list_tasks tool with a companyId" }),
          }],
        };
      }
      const issues = await client.requestJson("GET", `/companies/${companyId}/issues`);
      return {
        contents: [{ uri, mimeType: "application/json", text: JSON.stringify(issues, null, 2) }],
      };
    }
    throw new Error(`Unknown resource: ${uri}`);
  });

  return server;
}

export async function runServer(): Promise<void> {
  const config = readConfigFromEnv();
  const toolset = parseToolset(process.env.AGENTDASH_TOOLSET);
  const server = createAgentDashServer(config, { toolset });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // eslint-disable-next-line no-console
  console.error(`AgentDash MCP Server v${SERVER_VERSION} running on stdio (${config.apiUrl}, toolset=${toolset})`);
}
