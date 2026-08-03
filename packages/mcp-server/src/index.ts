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
import { readConfigFromEnv, type PaperclipMcpConfig } from "./config.js";
import { createJourneyToolDefinitions } from "./journey.js";
import { bridgeTools } from "./bridge.js";
import { harnessTools } from "./harness.js";
import { PLAYBOOK } from "./playbook.js";
import { RESOURCE_TEMPLATES, listResources, readAgentDashResource } from "./resources.js";
import { toolInputSchema } from "./schema.js";
import { createToolDefinitions, type ToolDefinition } from "./tools.js";

export const SERVER_NAME = "agentdash";
export const SERVER_VERSION = "0.2.0";

export function createAgentDashServer(config: PaperclipMcpConfig): Server {
  const client = new PaperclipApiClient(config);
  const tools: ToolDefinition[] = [
    ...createToolDefinitions(client),
    ...createJourneyToolDefinitions(client),
    ...bridgeTools(client),
    ...harnessTools(client),
  ];
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { resources: {}, tools: {} },
      instructions: PLAYBOOK,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: toolInputSchema(tool.schema),
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

  const resources = listResources();

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources }));

  /**
   * AgentDash-MK: the derivation record.
   *
   * Templates rather than fixed URIs, because the interesting resource is "this
   * figure" and there is one per fact. Read-only shared context: nothing
   * verifies that a harness read any of it, and the descriptions say so.
   */
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: RESOURCE_TEMPLATES.map((template) => ({ ...template })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    // Tried first, and returns null for anything it does not own, so the static
    // resources below are unchanged by its existence.
    const derivation = await readAgentDashResource(client, { companyId: config.companyId }, uri);
    if (derivation) return derivation;
    if (uri === "agentdash://playbook") {
      return {
        contents: [{ uri, mimeType: "text/markdown", text: PLAYBOOK }],
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
  const server = createAgentDashServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // eslint-disable-next-line no-console
  console.error(`AgentDash MCP Server v${SERVER_VERSION} running on stdio (${config.apiUrl})`);
}
