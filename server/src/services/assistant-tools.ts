/**
 * Internal toolkit for the Assistant Chatbot.
 * 6 core tools that map to AgentDash service functions.
 * AgentDash: assistant chatbot internal toolkit
 */
import type { Db } from "@agentdash/db";
import type { ToolDefinition } from "./assistant-llm.js";
import { agentService } from "./agents.js";
import { issueService } from "./issues.js";
import { goalService } from "./goals.js";
// AgentDash: Manual KPIs (AGE-45)
import { kpisService } from "./kpis.js";

// ── Tool Context (constructed from req.actor in route handler) ─────────

export interface ToolContext {
  userId: string;
  companyId: string;
  companyIds: string[];
  isInstanceAdmin: boolean;
  source: string;
}

export function assertToolAccess(ctx: ToolContext, targetCompanyId: string): void {
  if (ctx.isInstanceAdmin) return;
  if (ctx.source === "local_implicit") return;
  if (!ctx.companyIds.includes(targetCompanyId)) {
    throw Object.assign(new Error("Access denied"), { statusCode: 403 });
  }
}

// ── Tool Registry ──────────────────────────────────────────────────────

export interface Tool {
  definition: ToolDefinition;
  execute: (input: Record<string, unknown>, ctx: ToolContext, db: Db) => Promise<unknown>;
}

// ── Tool 1: create_agent ───────────────────────────────────────────────

function createAgentTool(_db: Db): Tool {
  return {
    definition: {
      name: "create_agent",
      description: "Create a new AI agent in the AgentDash platform for the current company.",
      input_schema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The name of the agent (must be unique within the company).",
          },
          role: {
            type: "string",
            description: "The agent's role (e.g. 'engineer', 'manager', 'analyst', 'general').",
          },
          title: {
            type: "string",
            description: "Optional human-readable job title for the agent.",
          },
          adapterType: {
            type: "string",
            description: "The adapter type to use for this agent (e.g. 'claude', 'codex', 'gemini').",
          },
        },
        required: ["name", "adapterType"],
      },
    },
    execute: async (input, ctx, db) => {
      assertToolAccess(ctx, ctx.companyId);
      const svc = agentService(db);
      return svc.create(ctx.companyId, {
        name: input.name as string,
        role: (input.role as string) ?? "general",
        title: (input.title as string | undefined) ?? null,
        adapterType: input.adapterType as string,
      });
    },
  };
}

// ── Tool 2: list_agents ────────────────────────────────────────────────

function listAgentsTool(_db: Db): Tool {
  return {
    definition: {
      name: "list_agents",
      description: "List all agents for the current company, with optional filtering by status or role.",
      input_schema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description: "Filter agents by status (e.g. 'active', 'idle', 'paused', 'terminated').",
          },
          role: {
            type: "string",
            description: "Filter agents by role (e.g. 'engineer', 'manager').",
          },
          includeTerminated: {
            type: "boolean",
            description: "Whether to include terminated agents. Defaults to false.",
          },
        },
        required: [],
      },
    },
    execute: async (input, ctx, db) => {
      assertToolAccess(ctx, ctx.companyId);
      const svc = agentService(db);
      const includeTerminated = Boolean(input.includeTerminated);
      let result = await svc.list(ctx.companyId, { includeTerminated });
      if (input.status) {
        result = result.filter((a) => a.status === input.status);
      }
      if (input.role) {
        result = result.filter((a) => a.role === input.role);
      }
      return result;
    },
  };
}

// ── Tool 3: create_issue ───────────────────────────────────────────────

function createIssueTool(_db: Db): Tool {
  return {
    definition: {
      name: "create_issue",
      description: "Create a new issue/task in AgentDash for the current company.",
      input_schema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "The title of the issue.",
          },
          description: {
            type: "string",
            description: "Optional detailed description of the issue.",
          },
          priority: {
            type: "string",
            description: "Issue priority: 'urgent', 'high', 'medium', or 'low'.",
          },
          assigneeAgentId: {
            type: "string",
            description: "Optional UUID of the agent to assign this issue to.",
          },
        },
        required: ["title"],
      },
    },
    execute: async (input, ctx, db) => {
      assertToolAccess(ctx, ctx.companyId);
      const svc = issueService(db);
      return svc.create(ctx.companyId, {
        title: input.title as string,
        description: (input.description as string | undefined) ?? null,
        priority: (input.priority as string | undefined) ?? "medium",
        assigneeAgentId: (input.assigneeAgentId as string | undefined) ?? null,
      });
    },
  };
}

// ── Tool 4: list_issues ────────────────────────────────────────────────

function listIssuesTool(_db: Db): Tool {
  return {
    definition: {
      name: "list_issues",
      description: "List issues for the current company with optional filters.",
      input_schema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            description: "Filter by status: 'backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'.",
          },
          assigneeAgentId: {
            type: "string",
            description: "Filter by the UUID of the assigned agent.",
          },
          projectId: {
            type: "string",
            description: "Filter issues belonging to a specific project UUID.",
          },
          q: {
            type: "string",
            description: "Full-text search query to filter issues by title or description.",
          },
        },
        required: [],
      },
    },
    execute: async (input, ctx, db) => {
      assertToolAccess(ctx, ctx.companyId);
      const svc = issueService(db);
      const filters: Record<string, unknown> = {};
      if (input.status) filters.status = input.status;
      if (input.assigneeAgentId) filters.assigneeAgentId = input.assigneeAgentId;
      if (input.projectId) filters.projectId = input.projectId;
      if (input.q) filters.q = input.q;
      return svc.list(ctx.companyId, filters);
    },
  };
}

// ── Tool 5: set_goal ───────────────────────────────────────────────────

function setGoalTool(_db: Db): Tool {
  return {
    definition: {
      name: "set_goal",
      description: "Create a new goal for the current company.",
      input_schema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "The title of the goal.",
          },
          description: {
            type: "string",
            description: "Optional description of the goal.",
          },
          level: {
            type: "string",
            description: "Goal level: 'company', 'team', or 'task'. Defaults to 'company'.",
          },
          targetDate: {
            type: "string",
            description: "Optional ISO 8601 date string for the goal's target completion date.",
          },
        },
        required: ["title"],
      },
    },
    execute: async (input, ctx, db) => {
      assertToolAccess(ctx, ctx.companyId);
      const svc = goalService(db);
      return svc.create(ctx.companyId, {
        title: input.title as string,
        description: (input.description as string | undefined) ?? null,
        level: (input.level as string | undefined) ?? "company",
        targetDate: input.targetDate ? new Date(input.targetDate as string) : null,
      });
    },
  };
}

// ── Tool: update_kpi (AgentDash: AGE-45) ───────────────────────────────

function updateKpiTool(_db: Db): Tool {
  return {
    definition: {
      name: "update_kpi",
      description:
        "Update the current value of a manually-tracked KPI for the current company. Identify the KPI via either its UUID (kpiId) or its exact name (kpiName).",
      input_schema: {
        type: "object",
        properties: {
          kpiId: {
            type: "string",
            description: "UUID of the KPI to update. Prefer this when known.",
          },
          kpiName: {
            type: "string",
            description:
              "Exact KPI name to update. Used only when kpiId is not provided. Must match an existing KPI for the current company.",
          },
          value: {
            type: "number",
            description: "The new current value for the KPI.",
          },
        },
        required: ["value"],
      },
    },
    execute: async (input, ctx, db) => {
      assertToolAccess(ctx, ctx.companyId);
      const svc = kpisService(db);
      const kpiId = input.kpiId as string | undefined;
      const kpiName = input.kpiName as string | undefined;
      const value = input.value;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw Object.assign(new Error("value must be a finite number"), { statusCode: 400 });
      }
      if (!kpiId && !kpiName) {
        throw Object.assign(new Error("Must provide kpiId or kpiName"), { statusCode: 400 });
      }

      let target = null;
      if (kpiId) {
        target = await svc.getById(kpiId);
        if (!target || target.companyId !== ctx.companyId) {
          throw Object.assign(new Error(`KPI not found: ${kpiId}`), { statusCode: 404 });
        }
      } else if (kpiName) {
        target = await svc.findByName(ctx.companyId, kpiName);
        if (!target) {
          throw Object.assign(new Error(`KPI not found by name: ${kpiName}`), { statusCode: 404 });
        }
      }
      if (!target) {
        throw Object.assign(new Error("KPI not found"), { statusCode: 404 });
      }

      return svc.setValue(target.id, value);
    },
  };
}

// ── Tool 6: get_dashboard_summary ──────────────────────────────────────

function getDashboardSummaryTool(_db: Db): Tool {
  return {
    definition: {
      name: "get_dashboard_summary",
      description: "Get a high-level summary of the current company's AgentDash workspace, including agent counts and recent issues.",
      input_schema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    execute: async (input, ctx, db) => {
      assertToolAccess(ctx, ctx.companyId);
      const agentSvc = agentService(db);
      const issueSvc = issueService(db);

      const [agentList, issueList] = await Promise.all([
        agentSvc.list(ctx.companyId),
        issueSvc.list(ctx.companyId, {}),
      ]);

      const agentsByStatus = agentList.reduce<Record<string, number>>((acc, agent) => {
        acc[agent.status] = (acc[agent.status] ?? 0) + 1;
        return acc;
      }, {});

      const issuesByStatus = issueList.reduce<Record<string, number>>((acc, issue) => {
        acc[issue.status] = (acc[issue.status] ?? 0) + 1;
        return acc;
      }, {});

      const openIssues = issueList.filter((i) =>
        ["backlog", "todo", "in_progress", "in_review", "blocked"].includes(i.status),
      );

      return {
        agents: {
          total: agentList.length,
          byStatus: agentsByStatus,
        },
        issues: {
          total: issueList.length,
          open: openIssues.length,
          byStatus: issuesByStatus,
        },
      };
    },
  };
}

// ── Public API ─────────────────────────────────────────────────────────

export function getAssistantTools(db: Db): Tool[] {
  return [
    createAgentTool(db),
    listAgentsTool(db),
    createIssueTool(db),
    listIssuesTool(db),
    setGoalTool(db),
    getDashboardSummaryTool(db),
    // AgentDash: Manual KPIs (AGE-45)
    updateKpiTool(db),
  ];
}

export function getToolDefinitions(db: Db): ToolDefinition[] {
  return getAssistantTools(db).map((t) => t.definition);
}

export async function executeTool(
  tools: Tool[],
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
  db: Db,
): Promise<unknown> {
  const tool = tools.find((t) => t.definition.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  assertToolAccess(ctx, ctx.companyId);
  return tool.execute(input, ctx, db);
}
