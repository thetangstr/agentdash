import { humanJsonSchema } from '@paperclipai/shared';
import { HUMAN_PLAYBOOK, humanTools, verifyHumanConnection } from './human.js';
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
import {
  CLOUD_PLAYBOOK,
  createCloudToolDefinitions,
  edgeDomainFor,
  httpCloudBackend,
  normalizeCloudUrl,
  type CloudBackend,
  type CloudConnection,
} from "./cloud.js";
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
export type AgentDashToolset = "setup" | "agent" | "assistant" | "human" | "cloud";

export const AGENTDASH_TOOLSETS: readonly AgentDashToolset[] = ["setup", "agent", "assistant", "human", "cloud"];

/**
 * AgentDash (cloud toolset, doc/plans/2026-10-31-cloud-mcp-toolset.md): where
 * the cloud tools send their calls. stdio passes `cloudUrl` (the public cloud
 * API); cloud-control's hosted endpoint passes its own in-process `backend`.
 */
export interface CloudToolsetOptions {
  backend?: CloudBackend;
  cloudUrl?: string;
  /** Overrides the edge domain derived from cloudUrl (AGENTDASH_CLOUD_EDGE_DOMAIN). */
  edgeDomain?: string;
}

export { CLOUD_OPS, CLOUD_PLAYBOOK, createCloudToolDefinitions, edgeDomainFor, httpCloudBackend, isWorkspaceApi, normalizeCloudUrl, DEFAULT_CLOUD_URL, DEFAULT_EDGE_DOMAIN } from "./cloud.js";
export { NO_INSTANCE_API_URL } from "./config.js";
export type { CloudBackend, CloudCallResult, CloudConnection, CloudOp } from "./cloud.js";

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
  cloud: CloudToolsetOptions & { onConnected?: (connection: CloudConnection) => Promise<Record<string, unknown>> } = {},
): ToolDefinition[] {
  if (toolset === "human") return humanTools(config);
  // The cloud tools talk to the AgentDash cloud, never to an instance, so the
  // instance credential's kind does not choose them. Until connect there is
  // no instance at all.
  if (toolset === "cloud") {
    const cloudUrl = cloud.cloudUrl ?? normalizeCloudUrl(undefined);
    const backend = cloud.backend ?? httpCloudBackend(cloudUrl);
    return createCloudToolDefinitions(backend, {
      edgeDomain: edgeDomainFor(cloudUrl, cloud.edgeDomain),
      ...(cloud.onConnected ? { onConnected: cloud.onConnected } : {}),
    });
  }
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
  options: { toolset?: AgentDashToolset; cloud?: CloudToolsetOptions } = {},
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
  // `let`: a cloud session's surface grows once, at connect (below).
  let tools: ToolDefinition[] = [];
  let toolsByName = new Map<string, ToolDefinition>();
  const setTools = (next: ToolDefinition[]) => {
    tools = next;
    toolsByName = new Map(next.map((tool) => [tool.name, tool]));
  };

  /**
   * AgentDash (cloud toolset): the in-place upgrade, the agentdash_sign_up
   * pattern one step further. The person approved this agent on their new
   * workspace and the credential arrived once; point this session's client at
   * the workspace, add the setup tools after the cloud ones, and tell the
   * harness its tool list changed. Only a session that holds state can do
   * this, so the hosted endpoint (which passes its own backend) never does.
   */
  const onConnected = async (connection: CloudConnection): Promise<Record<string, unknown>> => {
    client.setApiUrl(connection.apiUrl);
    client.setApiKey(connection.apiKey);
    const cloudTools = tools.filter((tool) => tool.name.startsWith("agentdash_cloud_"));
    setTools([...cloudTools, ...createJourneyToolDefinitions(client)]);
    await server.sendToolListChanged().catch(() => undefined);
    return {
      sessionUpgraded: true,
      nextAction: "agentdash_setup_status",
      nextActionReason:
        "This session now talks to the workspace with the setup tools (interview → plan → hire). "
        + "Call agentdash_setup_status and follow its nextAction.",
      apiKeyPersistInstructions:
        `To stay signed in on future sessions, run the AgentDash MCP server with AGENTDASH_TOOLSET=setup, `
        + `PAPERCLIP_API_URL=${connection.boxUrl} and PAPERCLIP_API_KEY set to apiKey. Keep the key secret.`,
    };
  };

  setTools(
    buildToolSurface(client, config, toolset, {
      ...options.cloud,
      ...(toolset === "cloud" && !options.cloud?.backend ? { onConnected } : {}),
    }),
  );

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { resources: {}, tools: toolset === "cloud" ? { listChanged: true } : {} },
      // Scoped to one agent → that agent's own contract; otherwise the
      // operator's. Serving the operator's playbook to a person's harness tells
      // it to go provision a company instead of doing the work it was given.
      // The assistant toolset gets its own contract: relaying to a person,
      // not doing the work.
      instructions: toolset === "human" ? HUMAN_PLAYBOOK : toolset === "cloud" ? CLOUD_PLAYBOOK : selectPlaybook({ agentId: config.agentId, toolset }),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (toolset === "human") await verifyHumanConnection(config);
    return { tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: toolset === "human" ? humanJsonSchema(tool.schema) : toolInputSchema(tool.schema),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    })), };
  });

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
  // The cloud toolset is in the same position: before connect there is no
  // instance whose resources could be read.
  const assistantOnly = toolset === "assistant" || toolset === "human" || toolset === "cloud";
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
        contents: [{ uri, mimeType: "text/markdown", text: toolset === "human" ? HUMAN_PLAYBOOK : toolset === "cloud" ? CLOUD_PLAYBOOK : selectPlaybook({ agentId: config.agentId, toolset }) }],
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
  const toolset = parseToolset(process.env.AGENTDASH_TOOLSET);
  // A cloud session has no instance yet: it learns the URL at connect.
  const config = readConfigFromEnv(process.env, { requireApiUrl: toolset !== "cloud" });
  if (toolset === "human") await verifyHumanConnection(config);
  const cloudUrl = toolset === "cloud" ? normalizeCloudUrl(process.env.AGENTDASH_CLOUD_URL) : undefined;
  const edgeDomain = process.env.AGENTDASH_CLOUD_EDGE_DOMAIN?.trim() || undefined;
  const server = createAgentDashServer(config, { toolset, ...(cloudUrl ? { cloud: { cloudUrl, ...(edgeDomain ? { edgeDomain } : {}) } } : {}) });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // eslint-disable-next-line no-console
  console.error(`AgentDash MCP Server v${SERVER_VERSION} running on stdio (${cloudUrl ?? config.apiUrl}, toolset=${toolset})`);
}
