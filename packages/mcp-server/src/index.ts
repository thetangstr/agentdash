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
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { PaperclipApiClient } from "./client.js";
import { readConfigFromEnv, type PaperclipMcpConfig } from "./config.js";
import { createJourneyToolDefinitions } from "./journey.js";
import { bridgeTools } from "./bridge.js";
import { PLAYBOOK } from "./playbook.js";
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

  const resources = [
    {
      uri: "agentdash://playbook",
      name: "Operating Playbook",
      description:
        "The goal-oriented operating contract: the setup-status loop, the approval boundaries, "
        + "and what to do when blocked. Read this before operating.",
      mimeType: "text/markdown",
    },
    {
      uri: "agentdash://dashboard",
      name: "Dashboard URL",
      description: "The AgentDash dashboard URL for this workspace",
      mimeType: "text/plain",
    },
    {
      uri: "agentdash://agents",
      name: "Agent Roster",
      description: "Current list of agents and their statuses",
      mimeType: "application/json",
    },
    {
      uri: "agentdash://tasks",
      name: "Task Board",
      description: "Current tasks and their statuses",
      mimeType: "application/json",
    },
  ];

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
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
