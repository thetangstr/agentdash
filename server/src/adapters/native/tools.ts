// AgentDash native adapter — tool definitions + handlers.
//
// Each tool = { schema (OpenAI function-calling format the gateway forwards to any
// provider), execute }. buildTools(ctx) closes over agent/company/issue identity so
// the model cannot spoof IDs. Tool errors are returned as { isError: true } results
// so the model can recover; only programmer errors throw.
//
// The 9 issue/comment/agent/approval tools are adapted from the MIT-licensed community
// OpenRouter adapter (github.com/talhamahmood666/paperclip-adapter-openrouter); the
// DoD / verdict / interaction / quota tools are AgentDash-specific.

import { PaperclipApi, PaperclipApiError } from "./paperclip-api.js";

export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ToolExecutionResult {
  content: string;
  isError: boolean;
}

export interface Tool {
  schema: ToolSchema;
  execute: (args: Record<string, unknown>) => Promise<ToolExecutionResult>;
}

export interface BuildToolsContext {
  api: PaperclipApi;
  agentId: string;
  companyId: string;
  /** The issue this run is working on, if any. Tools default to it when no id is supplied. */
  currentIssueId: string | null;
  /** When false, hire/mutating actions route through approvals first. */
  autoApprove: boolean;
}

function ok(content: string | Record<string, unknown>): ToolExecutionResult {
  return { content: typeof content === "string" ? content : JSON.stringify(content), isError: false };
}
function fail(message: string, detail?: unknown): ToolExecutionResult {
  const body: Record<string, unknown> = { error: message };
  if (detail !== undefined) body.detail = detail;
  return { content: JSON.stringify(body), isError: true };
}
async function safeCall<T>(label: string, fn: () => Promise<T>): Promise<ToolExecutionResult> {
  try {
    return ok((await fn()) as Record<string, unknown>);
  } catch (err) {
    if (err instanceof PaperclipApiError) {
      return fail(`${label} failed: ${err.message}`, { status: err.status, body: err.body });
    }
    return fail(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

function getIssueTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "get_issue",
        description: "Fetch full details of an issue (title, description, status). Defaults to the current issue.",
        parameters: { type: "object", properties: { issue_id: { type: "string", description: "Omit to use the current issue." } } },
      },
    },
    execute: async (args) => {
      const id = asString(args.issue_id, ctx.currentIssueId ?? "");
      if (!id) return fail("No issue_id supplied and no current issue.");
      return safeCall("get_issue", () => ctx.api.getIssue(id));
    },
  };
}

function updateIssueStatusTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "update_issue_status",
        description: "Move an issue to a new status. Defaults to the current issue.",
        parameters: {
          type: "object",
          properties: {
            issue_id: { type: "string", description: "Omit to use the current issue." },
            status: { type: "string", enum: ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"] },
            reason: { type: "string", description: "Optional explanation." },
          },
          required: ["status"],
        },
      },
    },
    execute: async (args) => {
      const id = asString(args.issue_id, ctx.currentIssueId ?? "");
      if (!id) return fail("No issue_id supplied and no current issue.");
      const status = asString(args.status);
      if (!status) return fail("status is required.");
      return safeCall("update_issue_status", () => ctx.api.updateIssue(id, { status, statusReason: args.reason ?? null }));
    },
  };
}

function addCommentTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "add_comment",
        description: "Post a comment on an issue to share progress, results, or questions. Defaults to the current issue.",
        parameters: {
          type: "object",
          properties: {
            issue_id: { type: "string", description: "Omit to use the current issue." },
            body: { type: "string", description: "Comment body in Markdown." },
          },
          required: ["body"],
        },
      },
    },
    execute: async (args) => {
      const id = asString(args.issue_id, ctx.currentIssueId ?? "");
      if (!id) return fail("No issue_id supplied and no current issue.");
      const body = asString(args.body);
      if (!body) return fail("body is required.");
      return safeCall("add_comment", () => ctx.api.addIssueComment(id, { body }));
    },
  };
}

function listCommentsTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "list_comments",
        description: "List all comments on an issue. Defaults to the current issue.",
        parameters: { type: "object", properties: { issue_id: { type: "string", description: "Omit to use the current issue." } } },
      },
    },
    execute: async (args) => {
      const id = asString(args.issue_id, ctx.currentIssueId ?? "");
      if (!id) return fail("No issue_id supplied and no current issue.");
      return safeCall("list_comments", () => ctx.api.listIssueComments(id));
    },
  };
}

function listIssuesTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "list_issues",
        description: "List issues in the current company, optionally filtered by status or assignee.",
        parameters: {
          type: "object",
          properties: {
            status: { type: "string" },
            assignee_agent_id: { type: "string" },
            limit: { type: "number", description: "Max results, default 20." },
          },
        },
      },
    },
    execute: async (args) => {
      const query: Record<string, string> = {};
      if (typeof args.status === "string") query.status = args.status;
      if (typeof args.assignee_agent_id === "string") query.assigneeAgentId = args.assignee_agent_id;
      query.limit = String(typeof args.limit === "number" ? args.limit : 20);
      return safeCall("list_issues", () => ctx.api.listCompanyIssues(ctx.companyId, query));
    },
  };
}

function listAgentsTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "list_agents",
        description: "List teammates in the company (id, name, role, status). Use before delegating to reference real agent ids.",
        parameters: { type: "object", properties: {} },
      },
    },
    execute: async () =>
      safeCall("list_agents", async () => {
        const agents = await ctx.api.listCompanyAgents(ctx.companyId);
        return agents.map((a) => ({
          id: a.id,
          name: a.name,
          role: a.role,
          title: a.title,
          adapterType: a.adapterType,
          status: a.status,
          reportsToAgentId: a.reportsToAgentId ?? null,
        }));
      }),
  };
}

function createSubIssueTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "create_sub_issue",
        description: "Create a child issue under a parent (defaults to current issue). Use to break down or delegate work.",
        parameters: {
          type: "object",
          properties: {
            parent_issue_id: { type: "string", description: "Omit to use the current issue." },
            title: { type: "string" },
            description: { type: "string" },
            assignee_agent_id: { type: "string" },
            priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
          },
          required: ["title"],
        },
      },
    },
    execute: async (args) => {
      const title = asString(args.title);
      if (!title) return fail("title is required.");
      const parentId = asString(args.parent_issue_id, ctx.currentIssueId ?? "");
      return safeCall("create_sub_issue", () =>
        ctx.api.createIssue(ctx.companyId, {
          title,
          description: args.description ?? "",
          parentId: parentId || undefined,
          assigneeAgentId: args.assignee_agent_id ?? undefined,
          priority: args.priority ?? undefined,
        }),
      );
    },
  };
}

function setDodTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "set_dod",
        description: "Set or update an issue's Definition of Done (acceptance criteria). Defaults to the current issue.",
        parameters: {
          type: "object",
          properties: {
            issue_id: { type: "string", description: "Omit to use the current issue." },
            summary: { type: "string", description: "One-line statement of what 'done' means." },
            criteria: {
              type: "array",
              description: "Acceptance criteria.",
              items: {
                type: "object",
                properties: {
                  description: { type: "string" },
                  evaluationGuidance: { type: "string" },
                  mustHave: { type: "boolean" },
                },
                required: ["description"],
              },
            },
            goalMetricLink: { type: "string" },
          },
          required: ["summary", "criteria"],
        },
      },
    },
    execute: async (args) => {
      const id = asString(args.issue_id, ctx.currentIssueId ?? "");
      if (!id) return fail("No issue_id supplied and no current issue.");
      const summary = asString(args.summary);
      const criteria = Array.isArray(args.criteria) ? (args.criteria as Array<Record<string, unknown>>) : [];
      if (!summary) return fail("summary is required.");
      if (criteria.length === 0) return fail("criteria must have at least one item.");
      return safeCall("set_dod", () =>
        ctx.api.setDefinitionOfDone(ctx.companyId, id, {
          summary,
          criteria,
          goalMetricLink: typeof args.goalMetricLink === "string" ? args.goalMetricLink : undefined,
        }),
      );
    },
  };
}

function writeVerdictTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "write_verdict",
        description:
          "Record a review verdict on an issue under review (in_review). Outcomes: passed, failed, revision_requested, escalated_to_human.",
        parameters: {
          type: "object",
          properties: {
            issue_id: { type: "string", description: "Omit to use the current issue." },
            outcome: { type: "string", enum: ["passed", "failed", "revision_requested", "escalated_to_human"] },
            justification: { type: "string" },
            rubricScores: { type: "object", description: "Optional rubric-key -> score (0-5) or {score, justification}." },
          },
          required: ["outcome"],
        },
      },
    },
    execute: async (args) => {
      const id = asString(args.issue_id, ctx.currentIssueId ?? "");
      if (!id) return fail("No issue_id supplied and no current issue.");
      const outcome = asString(args.outcome);
      if (!outcome) return fail("outcome is required.");
      return safeCall("write_verdict", () =>
        ctx.api.createVerdict(ctx.companyId, {
          entityType: "issue",
          issueId: id,
          reviewerAgentId: ctx.agentId,
          outcome,
          justification: typeof args.justification === "string" ? args.justification : undefined,
          rubricScores: args.rubricScores && typeof args.rubricScores === "object" ? args.rubricScores : undefined,
        }),
      );
    },
  };
}

function createInteractionTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "create_interaction",
        description:
          "Open a typed interaction on an issue: ask the user questions, suggest follow-up tasks, or request confirmation.",
        parameters: {
          type: "object",
          properties: {
            issue_id: { type: "string", description: "Omit to use the current issue." },
            kind: { type: "string", enum: ["suggest_tasks", "ask_user_questions", "request_confirmation"] },
            title: { type: "string" },
            summary: { type: "string" },
            payload: { type: "object", description: "Kind-specific payload (tasks / questions / targets)." },
          },
          required: ["kind", "payload"],
        },
      },
    },
    execute: async (args) => {
      const id = asString(args.issue_id, ctx.currentIssueId ?? "");
      if (!id) return fail("No issue_id supplied and no current issue.");
      const kind = asString(args.kind);
      if (!kind) return fail("kind is required.");
      const payload = args.payload && typeof args.payload === "object" ? args.payload : null;
      if (!payload) return fail("payload is required.");
      return safeCall("create_interaction", () =>
        ctx.api.createInteraction(id, {
          kind,
          title: typeof args.title === "string" ? args.title : undefined,
          summary: typeof args.summary === "string" ? args.summary : undefined,
          payload,
        }),
      );
    },
  };
}

function getQuotaTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "get_quota",
        description: "Get the company's current usage quota window and status (ok / warning / exceeded).",
        parameters: { type: "object", properties: {} },
      },
    },
    execute: async () => safeCall("get_quota", () => ctx.api.getQuota(ctx.companyId)),
  };
}

function requestApprovalTool(ctx: BuildToolsContext): Tool {
  return {
    schema: {
      type: "function",
      function: {
        name: "request_approval",
        description: "Open an approval request for an action needing human sign-off (hire_agent / approve_ceo_strategy / budget_override_required).",
        parameters: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["hire_agent", "approve_ceo_strategy", "budget_override_required"] },
            summary: { type: "string" },
            payload: { type: "object" },
          },
          required: ["type", "summary"],
        },
      },
    },
    execute: async (args) => {
      const type = asString(args.type);
      const summary = asString(args.summary);
      if (!type) return fail("type is required.");
      if (!summary) return fail("summary is required.");
      const payload = (args.payload && typeof args.payload === "object" ? args.payload : {}) as Record<string, unknown>;
      return safeCall("request_approval", () =>
        ctx.api.createApproval(ctx.companyId, { type, requestedByAgentId: ctx.agentId, payload: { ...payload, summary } }),
      );
    },
  };
}

export function buildTools(ctx: BuildToolsContext): Tool[] {
  return [
    getIssueTool(ctx),
    updateIssueStatusTool(ctx),
    addCommentTool(ctx),
    listCommentsTool(ctx),
    listIssuesTool(ctx),
    listAgentsTool(ctx),
    createSubIssueTool(ctx),
    setDodTool(ctx),
    writeVerdictTool(ctx),
    createInteractionTool(ctx),
    getQuotaTool(ctx),
    requestApprovalTool(ctx),
  ];
}

export function toolSchemas(tools: Tool[]): ToolSchema[] {
  return tools.map((t) => t.schema);
}
export function findTool(tools: Tool[], name: string): Tool | null {
  return tools.find((t) => t.schema.function.name === name) ?? null;
}
