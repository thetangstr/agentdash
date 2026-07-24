/**
 * AgentDash MCP Server
 *
 * Exposes AgentDash onboarding, provisioning, and management as MCP tools.
 * Users add this server to their AI tool (Claude Desktop, Cursor, Codex, the agent)
 * and the interview + provisioning happens naturally in conversation.
 *
 * Usage in Claude Desktop's claude_desktop_config.json:
 * {
 *   "mcpServers": {
 *     "agentdash": {
 *       "command": "npx",
 *       "args": ["-y", "@agentdash/mcp-server"],
 *       "env": {
 *         "AGENTDASH_API_URL": "http://localhost:3100/api",
 *         "AGENTDASH_API_KEY": "agent-key-here"
 *       }
 *     }
 *   }
 * }
 *
 * Or for cloud:
 *   "AGENTDASH_API_URL": "https://agentdash.cloud/api"
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const AGENTDASH_API_URL =
  process.env.AGENTDASH_API_URL ?? "http://localhost:3100/api";
const AGENTDASH_API_KEY = process.env.AGENTDASH_API_KEY ?? "";

// ---------------------------------------------------------------------------
// AgentDash API client
// ---------------------------------------------------------------------------

async function apiCall(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${AGENTDASH_API_URL}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (AGENTDASH_API_KEY) {
    headers["Authorization"] = `Bearer ${AGENTDASH_API_KEY}`;
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`AgentDash API ${res.status}: ${text}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "agentdash_start_interview",
    description:
      "Starts the AgentDash onboarding interview. Ask the user about their company, goals, and what they want AI agents to do. This begins the deep-interview process that will result in a proposed agent team.",
    inputSchema: {
      type: "object" as const,
      properties: {
        companyName: {
          type: "string",
          description: "The name of the company (ask the user if not provided)",
        },
        companyDescription: {
          type: "string",
          description: "What the company does",
        },
      },
      required: ["companyName"],
    },
  },
  {
    name: "agentdash_interview_turn",
    description:
      "Submit one round of the onboarding interview. Pass the user's answer to the current question. Returns either the next question or a signal that the interview is complete and a plan is ready.",
    inputSchema: {
      type: "object" as const,
      properties: {
        conversationId: {
          type: "string",
          description: "The conversation ID from start_interview",
        },
        userMessage: {
          type: "string",
          description: "The user's response to the current interview question",
        },
      },
      required: ["conversationId", "userMessage"],
    },
  },
  {
    name: "agentdash_get_plan",
    description:
      "Get the proposed agent team plan after the interview completes. Shows the recommended agents, their roles, and capabilities. Present this to the user for approval.",
    inputSchema: {
      type: "object" as const,
      properties: {
        conversationId: {
          type: "string",
          description: "The conversation ID from the interview",
        },
      },
      required: ["conversationId"],
    },
  },
  {
    name: "agentdash_confirm_plan",
    description:
      "Confirm and materialize the proposed agent team. Creates the agents in AgentDash. Only call this after the user approves the plan.",
    inputSchema: {
      type: "object" as const,
      properties: {
        conversationId: {
          type: "string",
          description: "The conversation ID from the interview",
        },
      },
      required: ["conversationId"],
    },
  },
  {
    name: "agentdash_revise_plan",
    description:
      "Request revisions to the proposed agent team plan. Pass the user's feedback.",
    inputSchema: {
      type: "object" as const,
      properties: {
        conversationId: {
          type: "string",
          description: "The conversation ID",
        },
        revisionText: {
          type: "string",
          description: "What the user wants changed about the plan",
        },
      },
      required: ["conversationId", "revisionText"],
    },
  },
  {
    name: "agentdash_list_agents",
    description:
      "List all agents in the AgentDash workspace with their current status.",
    inputSchema: {
      type: "object" as const,
      properties: {
        companyId: {
          type: "string",
          description: "Company ID (optional, uses default if omitted)",
        },
      },
    },
  },
  {
    name: "agentdash_list_tasks",
    description:
      "List all tasks/issues in the AgentDash workspace. Filter by status or assignee.",
    inputSchema: {
      type: "object" as const,
      properties: {
        companyId: {
          type: "string",
          description: "Company ID",
        },
        status: {
          type: "string",
          enum: ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"],
          description: "Filter by status",
        },
      },
    },
  },
  {
    name: "agentdash_create_task",
    description:
      "Create a new task/issue in AgentDash and optionally assign it to an agent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        companyId: { type: "string", description: "Company ID" },
        title: { type: "string", description: "Task title" },
        description: { type: "string", description: "Detailed task description" },
        priority: {
          type: "string",
          enum: ["critical", "high", "medium", "low"],
          default: "medium",
        },
        assigneeAgentId: {
          type: "string",
          description: "Agent ID to assign (optional)",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "agentdash_get_dashboard",
    description:
      "Get the company dashboard summary: agent counts, task counts, spend, pending approvals.",
    inputSchema: {
      type: "object" as const,
      properties: {
        companyId: { type: "string", description: "Company ID" },
      },
    },
  },
  {
    name: "agentdash_pause_agent",
    description: "Pause an agent so it stops picking up new work.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agentId: { type: "string", description: "Agent ID to pause" },
      },
      required: ["agentId"],
    },
  },
  {
    name: "agentdash_resume_agent",
    description: "Resume a paused agent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        agentId: { type: "string", description: "Agent ID to resume" },
      },
      required: ["agentId"],
    },
  },
  {
    name: "agentdash_install_local",
    description:
      "Returns instructions for installing AgentDash on-prem (Mac mini, server). Does NOT execute the install — returns the steps and env template for the user to run.",
    inputSchema: {
      type: "object" as const,
      properties: {
        companyName: { type: "string", description: "Company name for the license" },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "agentdash_start_interview": {
      // Bootstrap creates a workspace + CoS + conversation
      const result = await apiCall("POST", "/onboarding/bootstrap", {});
      const r = result as { companyId: string; cosAgentId: string; conversationId: string };
      return JSON.stringify({
        status: "interview_started",
        companyId: r.companyId,
        conversationId: r.conversationId,
        message: `Great! I've created a workspace for ${args.companyName ?? "your company"}. Let's start the onboarding interview. I'll ask you a few questions about your company and goals, then propose a team of AI agents.`,
      }, null, 2);
    }

    case "agentdash_interview_turn": {
      const result = await apiCall("POST", "/onboarding/interview/turn", {
        conversationId: args.conversationId,
        userMessage: args.userMessage,
        companyId: args.companyId,
        cosAgentId: args.cosAgentId,
      });
      return JSON.stringify(result, null, 2);
    }

    case "agentdash_get_plan": {
      // Read the latest plan proposal from the conversation
      const result = await apiCall("GET", `/conversations/${args.conversationId}/messages?limit=1`);
      return JSON.stringify({
        status: "plan_ready",
        message: "The plan has been proposed in the conversation. Present it to the user for approval.",
        conversationMessages: result,
      }, null, 2);
    }

    case "agentdash_confirm_plan": {
      const result = await apiCall("POST", "/onboarding/confirm-plan", {
        conversationId: args.conversationId,
      });
      const r = result as { companyId: string; createdAgentIds: string[] };
      return JSON.stringify({
        status: "agents_created",
        companyId: r.companyId,
        agentCount: r.createdAgentIds.length,
        message: `Your agent team has been created! ${r.createdAgentIds.length} agents are now active and ready for work. Open your dashboard at ${AGENTDASH_API_URL.replace("/api", "")} to see them.`,
      }, null, 2);
    }

    case "agentdash_revise_plan": {
      const result = await apiCall("POST", "/onboarding/revise-plan", {
        conversationId: args.conversationId,
        revisionText: args.revisionText,
      });
      return JSON.stringify(result, null, 2);
    }

    case "agentdash_list_agents": {
      const companyId = args.companyId as string;
      const result = await apiCall("GET", `/companies/${companyId}/agents`);
      return JSON.stringify(result, null, 2);
    }

    case "agentdash_list_tasks": {
      const companyId = args.companyId as string;
      const status = args.status ? `?status=${args.status}` : "";
      const result = await apiCall("GET", `/companies/${companyId}/issues${status}`);
      return JSON.stringify(result, null, 2);
    }

    case "agentdash_create_task": {
      const companyId = args.companyId as string;
      const result = await apiCall("POST", `/companies/${companyId}/issues`, {
        title: args.title,
        description: args.description ?? "",
        priority: args.priority ?? "medium",
        assigneeAgentId: args.assigneeAgentId,
        status: "todo",
      });
      return JSON.stringify({
        status: "task_created",
        task: result,
      }, null, 2);
    }

    case "agentdash_get_dashboard": {
      const companyId = args.companyId as string;
      const result = await apiCall("GET", `/companies/${companyId}/dashboard`);
      return JSON.stringify(result, null, 2);
    }

    case "agentdash_pause_agent": {
      await apiCall("POST", `/agents/${args.agentId}/pause`);
      return JSON.stringify({ status: "paused", agentId: args.agentId });
    }

    case "agentdash_resume_agent": {
      await apiCall("POST", `/agents/${args.agentId}/resume`);
      return JSON.stringify({ status: "resumed", agentId: args.agentId });
    }

    case "agentdash_install_local": {
      return JSON.stringify({
        status: "install_instructions",
        steps: [
          "1. Install Node.js 20+ and pnpm 9+",
          "2. git clone https://github.com/thetangstr/agentdash.git ~/agentdash",
          "3. cd ~/agentdash && pnpm install && pnpm build",
          "4. ./docker/launchd/install.sh",
          "5. Edit ~/.config/agentdash/agentdash.env with your config",
          "6. launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent",
          "7. Open http://localhost:3100",
        ],
        docsUrl: "https://github.com/thetangstr/agentdash#readme",
        envTemplate: `PAPERCLIP_DEPLOYMENT_MODE=authenticated\nAGENTDASH_DEFAULT_ADAPTER=claude_local\nDISABLE_AUTOUPDATER=1`,
      }, null, 2);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

const RESOURCES = [
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

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "agentdash", version: "0.1.0" },
  { capabilities: { resources: {}, tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await handleToolCall(name, args ?? {});
    return {
      content: [{ type: "text", text: result }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: RESOURCES,
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  if (uri === "agentdash://dashboard") {
    return {
      contents: [
        {
          uri,
          mimeType: "text/plain",
          text: AGENTDASH_API_URL.replace("/api", ""),
        },
      ],
    };
  }
  if (uri === "agentdash://agents") {
    // Would need company ID — return instruction
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify({ hint: "Use agentdash_list_agents tool with a companyId" }),
        },
      ],
    };
  }
  if (uri === "agentdash://tasks") {
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify({ hint: "Use agentdash_list_tasks tool with a companyId" }),
        },
      ],
    };
  }
  throw new Error(`Unknown resource: ${uri}`);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // eslint-disable-next-line no-console
  console.error("AgentDash MCP Server running on stdio");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal error:", err);
  process.exit(1);
});
