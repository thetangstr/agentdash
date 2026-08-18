import { z } from "zod";
import {
  addIssueCommentSchema,
  askUserQuestionsPayloadSchema,
  checkoutIssueSchema,
  createApprovalSchema,
  createCompanySchema,
  createIssueSchema,
  issueThreadInteractionContinuationPolicySchema,
  requestConfirmationPayloadSchema,
  suggestTasksPayloadSchema,
  updateIssueSchema,
  upsertIssueDocumentSchema,
  linkIssueApprovalSchema,
} from "@paperclipai/shared";
import { PaperclipApiClient } from "./client.js";
import { formatErrorResponse, formatTextResponse } from "./format.js";

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.AnyZodObject;
  execute: (input: Record<string, unknown>) => Promise<{
    content: Array<{ type: "text"; text: string }>;
  }>;
}

export function makeTool<TSchema extends z.ZodRawShape>(
  name: string,
  description: string,
  schema: z.ZodObject<TSchema>,
  execute: (input: z.infer<typeof schema>) => Promise<unknown>,
): ToolDefinition {
  return {
    name,
    description,
    schema,
    execute: async (input) => {
      try {
        const parsed = schema.parse(input);
        return formatTextResponse(await execute(parsed));
      } catch (error) {
        return formatErrorResponse(error);
      }
    },
  };
}

function parseOptionalJson(raw: string | undefined | null): unknown {
  if (!raw || raw.trim().length === 0) return undefined;
  return JSON.parse(raw);
}

const companyIdOptional = z.string().uuid().optional().nullable();
const agentIdOptional = z.string().uuid().optional().nullable();
const issueIdSchema = z.string().min(1);
const projectIdSchema = z.string().min(1);
const goalIdSchema = z.string().uuid();
const approvalIdSchema = z.string().uuid();
const documentKeySchema = z.string().trim().min(1).max(64);

const listIssuesSchema = z.object({
  companyId: companyIdOptional,
  status: z.string().optional(),
  projectId: z.string().uuid().optional(),
  assigneeAgentId: z.string().uuid().optional(),
  participantAgentId: z.string().uuid().optional(),
  assigneeUserId: z.string().optional(),
  touchedByUserId: z.string().optional(),
  inboxArchivedByUserId: z.string().optional(),
  unreadForUserId: z.string().optional(),
  labelId: z.string().uuid().optional(),
  executionWorkspaceId: z.string().uuid().optional(),
  originKind: z.string().optional(),
  originId: z.string().optional(),
  includeRoutineExecutions: z.boolean().optional(),
  q: z.string().optional(),
});

const listCommentsSchema = z.object({
  issueId: issueIdSchema,
  after: z.string().uuid().optional(),
  order: z.enum(["asc", "desc"]).optional(),
  limit: z.number().int().positive().max(500).optional(),
});

const upsertDocumentToolSchema = z.object({
  issueId: issueIdSchema,
  key: documentKeySchema,
  title: z.string().trim().max(200).nullable().optional(),
  format: z.enum(["markdown"]).default("markdown"),
  body: z.string().max(524288),
  changeSummary: z.string().trim().max(500).nullable().optional(),
  baseRevisionId: z.string().uuid().nullable().optional(),
});

const createIssueToolSchema = z.object({
  companyId: companyIdOptional,
}).merge(createIssueSchema);

const updateIssueToolSchema = z.object({
  issueId: issueIdSchema,
}).merge(updateIssueSchema);

const checkoutIssueToolSchema = z.object({
  issueId: issueIdSchema,
  agentId: agentIdOptional,
  expectedStatuses: checkoutIssueSchema.shape.expectedStatuses.optional(),
});

const addCommentToolSchema = z.object({
  issueId: issueIdSchema,
}).merge(addIssueCommentSchema);

const createSuggestTasksToolSchema = z.object({
  issueId: issueIdSchema,
  idempotencyKey: z.string().trim().max(255).nullable().optional(),
  sourceCommentId: z.string().uuid().nullable().optional(),
  sourceRunId: z.string().uuid().nullable().optional(),
  title: z.string().trim().max(240).nullable().optional(),
  summary: z.string().trim().max(1000).nullable().optional(),
  continuationPolicy: issueThreadInteractionContinuationPolicySchema.optional().default("wake_assignee"),
  payload: suggestTasksPayloadSchema,
});

const createAskUserQuestionsToolSchema = z.object({
  issueId: issueIdSchema,
  idempotencyKey: z.string().trim().max(255).nullable().optional(),
  sourceCommentId: z.string().uuid().nullable().optional(),
  sourceRunId: z.string().uuid().nullable().optional(),
  title: z.string().trim().max(240).nullable().optional(),
  summary: z.string().trim().max(1000).nullable().optional(),
  continuationPolicy: issueThreadInteractionContinuationPolicySchema.optional().default("wake_assignee"),
  payload: askUserQuestionsPayloadSchema,
});

const createRequestConfirmationToolSchema = z.object({
  issueId: issueIdSchema,
  idempotencyKey: z.string().trim().max(255).nullable().optional(),
  sourceCommentId: z.string().uuid().nullable().optional(),
  sourceRunId: z.string().uuid().nullable().optional(),
  title: z.string().trim().max(240).nullable().optional(),
  summary: z.string().trim().max(1000).nullable().optional(),
  continuationPolicy: issueThreadInteractionContinuationPolicySchema.optional().default("none"),
  payload: requestConfirmationPayloadSchema,
});

const approvalDecisionSchema = z.object({
  approvalId: approvalIdSchema,
  action: z.enum(["approve", "reject", "requestRevision", "resubmit"]),
  decisionNote: z.string().optional(),
  payloadJson: z.string().optional(),
});

const createApprovalToolSchema = z.object({
  companyId: companyIdOptional,
}).merge(createApprovalSchema);

const apiRequestSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().min(1),
  jsonBody: z.string().optional(),
});

// AgentDash: company-provisioning + CoS onboarding tool schemas.
const cosChatToolSchema = z.object({
  companyId: companyIdOptional,
  message: z.string().min(1),
});

const readConversationToolSchema = z.object({
  conversationId: z.string().uuid(),
  limit: z.number().int().positive().max(200).optional(),
});

const hireAgentToolSchema = z.object({
  companyId: companyIdOptional,
  name: z.string().min(1),
  adapterType: z.string().min(1),
  role: z.string().optional(),
  title: z.string().optional().nullable(),
  capabilities: z.string().optional().nullable(),
  desiredSkills: z.array(z.string().min(1)).optional(),
  budgetMonthlyCents: z.number().int().nonnegative().optional(),
});

const workspaceRuntimeControlTargetSchema = z.object({
  workspaceCommandId: z.string().min(1).optional().nullable(),
  runtimeServiceId: z.string().uuid().optional().nullable(),
  serviceIndex: z.number().int().nonnegative().optional().nullable(),
});

const issueWorkspaceRuntimeControlSchema = z.object({
  issueId: issueIdSchema,
  action: z.enum(["start", "stop", "restart"]),
}).merge(workspaceRuntimeControlTargetSchema);

const waitForIssueWorkspaceServiceSchema = z.object({
  issueId: issueIdSchema,
  runtimeServiceId: z.string().uuid().optional().nullable(),
  serviceName: z.string().min(1).optional().nullable(),
  timeoutSeconds: z.number().int().positive().max(300).optional(),
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readCurrentExecutionWorkspace(context: unknown): Record<string, unknown> | null {
  if (!context || typeof context !== "object") return null;
  const workspace = (context as { currentExecutionWorkspace?: unknown }).currentExecutionWorkspace;
  return workspace && typeof workspace === "object" ? workspace as Record<string, unknown> : null;
}

function readWorkspaceRuntimeServices(workspace: Record<string, unknown> | null): Array<Record<string, unknown>> {
  const raw = workspace?.runtimeServices;
  return Array.isArray(raw)
    ? raw.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    : [];
}

function selectRuntimeService(
  services: Array<Record<string, unknown>>,
  input: { runtimeServiceId?: string | null; serviceName?: string | null },
) {
  if (input.runtimeServiceId) {
    return services.find((service) => service.id === input.runtimeServiceId) ?? null;
  }
  if (input.serviceName) {
    return services.find((service) => service.serviceName === input.serviceName) ?? null;
  }
  return services.find((service) => service.status === "running" || service.status === "starting")
    ?? services[0]
    ?? null;
}

async function getIssueWorkspaceRuntime(client: PaperclipApiClient, issueId: string) {
  const context = await client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/heartbeat-context`);
  const workspace = readCurrentExecutionWorkspace(context);
  return {
    context,
    workspace,
    runtimeServices: readWorkspaceRuntimeServices(workspace),
  };
}

export function createToolDefinitions(client: PaperclipApiClient): ToolDefinition[] {
  return [
    makeTool(
      "whoami",
      "Get the current authenticated AgentDash actor details",
      z.object({}),
      async () => client.requestJson("GET", "/agents/me"),
    ),
    /**
     * Read the mandate the playbook tells this agent to obey.
     *
     * The playbook states "Read your mandate… your mandate outranks everything
     * in this playbook", and no tool existed to fetch it — found by driving a
     * real Claude Code through this surface, which hit a wall on the one
     * document that governs what it may do. The REST side always permitted it
     * (assertCanReadAgent allows an agent within its own company); only the
     * tool was missing, so an agent was told to obey a file it could not read.
     *
     * Returns the entry file's CONTENT, not a listing: an agent that has to
     * make a second call to learn its own rules will sometimes skip it.
     */
    makeTool(
      "agentdashGetMyMandate",
      "Read this agent's own mandate (the AGENTS.md entry file of its instruction bundle) — who it is, what it may do unattended, what needs a human first, and what it must never do. Call this before acting.",
      z.object({ agentId: z.string().uuid().optional().nullable() }),
      async ({ agentId }) => {
        const id = client.resolveAgentId(agentId);
        const bundle = (await client.requestJson(
          "GET",
          `/agents/${encodeURIComponent(id)}/instructions-bundle`,
        )) as { entryFile?: string | null; mode?: string | null };
        const entryFile = bundle?.entryFile;
        if (!entryFile) {
          return {
            mandate: null,
            reason:
              "This agent has no instruction bundle entry file. Ask your steward to write a mandate in the AgentDash UI (My Agent → Mandate).",
            bundle,
          };
        }
        const file = (await client.requestJson(
          "GET",
          `/agents/${encodeURIComponent(id)}/instructions-bundle/file?path=${encodeURIComponent(entryFile)}`,
        )) as { content?: string };
        return {
          entryFile,
          mode: bundle.mode ?? null,
          mandate: file?.content ?? "",
        };
      },
    ),
    makeTool(
      "inbox_lite",
      "Get the current authenticated agent inbox-lite assignment list",
      z.object({}),
      async () => client.requestJson("GET", "/agents/me/inbox-lite"),
    ),
    makeTool(
      "list_agents",
      "List agents in a company",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) => client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/agents`),
    ),
    makeTool(
      "get_agent",
      "Get a single agent by id",
      z.object({ agentId: z.string().min(1), companyId: companyIdOptional }),
      async ({ agentId, companyId }) => {
        const qs = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
        return client.requestJson("GET", `/agents/${encodeURIComponent(agentId)}${qs}`);
      },
    ),
    // Renaming an agent was reported as a bug during external testing. It was
    // not one: `PATCH /agents/:id` has always accepted a new name. The tool
    // surface just never said so, and this surface IS the product for anyone
    // driving AgentDash from their own terminal -- if a capability is not a
    // tool, it does not exist, no matter what the REST API can do.
    //
    // `api_request` could technically have done it, but only for
    // someone who already knew the route and body shape. That is a fallback
    // for the long tail, not an answer for "rename this agent".
    //
    // Deliberately narrow: the identity fields a person actually renames, not
    // the whole update schema. Adapter/runtime/budget changes are a different
    // job with different blast radius, and they stay on the escape hatch until
    // they earn a tool of their own.
    makeTool(
      "update_agent",
      "Rename or retitle an agent: update its name, role, title, icon, reporting line, or capabilities. Only the fields you pass are changed.",
      // A plain object, not a `.refine()`: `makeTool` needs a ZodObject so the
      // server can read `.shape` when it advertises this tool's JSON schema.
      // A ZodEffects type-checks as a validator and then hides the shape, so
      // the "at least one field" rule lives in the handler instead.
      z.object({
        agentId: z.string().min(1),
        companyId: companyIdOptional,
        name: z.string().trim().min(1).optional(),
        role: z.string().trim().min(1).optional(),
        title: z.string().trim().optional().nullable(),
        icon: z.string().trim().optional().nullable(),
        reportsTo: z.string().uuid().optional().nullable(),
        capabilities: z.string().optional().nullable(),
      }),
      async ({ agentId, companyId, ...changes }) => {
        // Drop only `undefined`. An explicit null is meaningful here -- it is
        // how a caller clears a title or detaches a reporting line -- so it
        // has to survive into the request body.
        const body = Object.fromEntries(
          Object.entries(changes).filter(([, value]) => value !== undefined),
        );
        if (Object.keys(body).length === 0) {
          // Say what to pass. An agent that gets "no changes" back with no
          // vocabulary will retry the same empty call.
          throw new Error(
            "Pass at least one field to change: name, role, title, icon, reportsTo, or capabilities",
          );
        }
        const qs = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
        return client.requestJson("PATCH", `/agents/${encodeURIComponent(agentId)}${qs}`, { body });
      },
    ),
    makeTool(
      "list_issues",
      "List issues for a company with optional filters",
      listIssuesSchema,
      async (input) => {
        const companyId = client.resolveCompanyId(input.companyId);
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(input)) {
          if (key === "companyId" || value === undefined || value === null) continue;
          params.set(key, String(value));
        }
        const qs = params.toString();
        return client.requestJson("GET", `/companies/${companyId}/issues${qs ? `?${qs}` : ""}`);
      },
    ),
    makeTool(
      "get_issue",
      "Get a single issue by UUID or identifier",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) => client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}`),
    ),
    makeTool(
      "get_heartbeat_context",
      "Get compact heartbeat context for an issue",
      z.object({ issueId: issueIdSchema, wakeCommentId: z.string().uuid().optional() }),
      async ({ issueId, wakeCommentId }) => {
        const qs = wakeCommentId ? `?wakeCommentId=${encodeURIComponent(wakeCommentId)}` : "";
        return client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/heartbeat-context${qs}`);
      },
    ),
    makeTool(
      "list_comments",
      "List issue comments with incremental options",
      listCommentsSchema,
      async ({ issueId, after, order, limit }) => {
        const params = new URLSearchParams();
        if (after) params.set("after", after);
        if (order) params.set("order", order);
        if (limit) params.set("limit", String(limit));
        const qs = params.toString();
        return client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/comments${qs ? `?${qs}` : ""}`);
      },
    ),
    makeTool(
      "get_comment",
      "Get a specific issue comment by id",
      z.object({ issueId: issueIdSchema, commentId: z.string().uuid() }),
      async ({ issueId, commentId }) =>
        client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/comments/${encodeURIComponent(commentId)}`),
    ),
    makeTool(
      "list_issue_approvals",
      "List approvals linked to an issue",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) => client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/approvals`),
    ),
    makeTool(
      "list_documents",
      "List issue documents",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) => client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/documents`),
    ),
    makeTool(
      "get_document",
      "Get one issue document by key",
      z.object({ issueId: issueIdSchema, key: documentKeySchema }),
      async ({ issueId, key }) =>
        client.requestJson("GET", `/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}`),
    ),
    makeTool(
      "list_document_revisions",
      "List revisions for an issue document",
      z.object({ issueId: issueIdSchema, key: documentKeySchema }),
      async ({ issueId, key }) =>
        client.requestJson(
          "GET",
          `/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}/revisions`,
        ),
    ),
    makeTool(
      "list_projects",
      "List projects in a company",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) => client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/projects`),
    ),
    makeTool(
      "get_project",
      "Get a project by id or company-scoped short reference",
      z.object({ projectId: projectIdSchema, companyId: companyIdOptional }),
      async ({ projectId, companyId }) => {
        const qs = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
        return client.requestJson("GET", `/projects/${encodeURIComponent(projectId)}${qs}`);
      },
    ),
    makeTool(
      "get_issue_workspace_runtime",
      "Get the current execution workspace and runtime services for an issue, including service URLs",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) => getIssueWorkspaceRuntime(client, issueId),
    ),
    makeTool(
      "control_issue_workspace_services",
      "Start, stop, or restart the current issue execution workspace runtime services",
      issueWorkspaceRuntimeControlSchema,
      async ({ issueId, action, ...target }) => {
        const runtime = await getIssueWorkspaceRuntime(client, issueId);
        const workspaceId = typeof runtime.workspace?.id === "string" ? runtime.workspace.id : null;
        if (!workspaceId) {
          throw new Error("Issue has no current execution workspace");
        }
        return client.requestJson(
          "POST",
          `/execution-workspaces/${encodeURIComponent(workspaceId)}/runtime-services/${action}`,
          { body: target },
        );
      },
    ),
    makeTool(
      "wait_for_issue_workspace_service",
      "Wait until an issue execution workspace runtime service is running and has a URL when one is exposed",
      waitForIssueWorkspaceServiceSchema,
      async ({ issueId, runtimeServiceId, serviceName, timeoutSeconds }) => {
        const deadline = Date.now() + (timeoutSeconds ?? 60) * 1000;
        let latest: Awaited<ReturnType<typeof getIssueWorkspaceRuntime>> | null = null;
        while (Date.now() <= deadline) {
          latest = await getIssueWorkspaceRuntime(client, issueId);
          const service = selectRuntimeService(latest.runtimeServices, { runtimeServiceId, serviceName });
          if (service?.status === "running" && service.healthStatus !== "unhealthy") {
            return {
              workspace: latest.workspace,
              service,
            };
          }
          await sleep(1000);
        }

        return {
          timedOut: true,
          latestWorkspace: latest?.workspace ?? null,
          latestRuntimeServices: latest?.runtimeServices ?? [],
        };
      },
    ),
    makeTool(
      "list_goals",
      "List goals in a company",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) => client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/goals`),
    ),
    makeTool(
      "get_goal",
      "Get a goal by id",
      z.object({ goalId: goalIdSchema }),
      async ({ goalId }) => client.requestJson("GET", `/goals/${encodeURIComponent(goalId)}`),
    ),
    makeTool(
      "list_approvals",
      "List approvals in a company",
      z.object({ companyId: companyIdOptional, status: z.string().optional() }),
      async ({ companyId, status }) => {
        const qs = status ? `?status=${encodeURIComponent(status)}` : "";
        return client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/approvals${qs}`);
      },
    ),
    makeTool(
      "create_approval",
      "Create a board approval request, optionally linked to one or more issues",
      createApprovalToolSchema,
      async ({ companyId, ...body }) =>
        client.requestJson("POST", `/companies/${client.resolveCompanyId(companyId)}/approvals`, {
          body,
        }),
    ),
    makeTool(
      "mandated_attest",
      "Perform a mandated action: verify the agent's mandate (in-scope, under-cap, unexpired), KYA the counterparty (valid-at-T), then attest the action. Returns { authorized, reason?, receipt? }. Denied when out-of-scope/over-cap/expired or the counterparty can't be verified.",
      z.object({
        companyId: companyIdOptional,
        granteeAgentId: z.string().uuid().optional(),
        mandateId: z.string().uuid(),
        counterpartyDid: z.string().min(1),
        action: z.string().min(1),
        payload: z.record(z.unknown()).optional(),
      }),
      async ({ companyId, ...body }) =>
        client.requestJson("POST", `/companies/${client.resolveCompanyId(companyId)}/mandated-actions`, { body }),
    ),
    makeTool(
      "get_approval",
      "Get an approval by id",
      z.object({ approvalId: approvalIdSchema }),
      async ({ approvalId }) => client.requestJson("GET", `/approvals/${encodeURIComponent(approvalId)}`),
    ),
    makeTool(
      "get_approval_issues",
      "List issues linked to an approval",
      z.object({ approvalId: approvalIdSchema }),
      async ({ approvalId }) => client.requestJson("GET", `/approvals/${encodeURIComponent(approvalId)}/issues`),
    ),
    makeTool(
      "list_approval_comments",
      "List comments for an approval",
      z.object({ approvalId: approvalIdSchema }),
      async ({ approvalId }) => client.requestJson("GET", `/approvals/${encodeURIComponent(approvalId)}/comments`),
    ),
    makeTool(
      "create_issue",
      "Create a new issue",
      createIssueToolSchema,
      async ({ companyId, ...body }) =>
        client.requestJson("POST", `/companies/${client.resolveCompanyId(companyId)}/issues`, { body }),
    ),
    makeTool(
      "update_issue",
      "Patch an issue, optionally including a comment; include resume=true when intentionally requesting follow-up on resumable closed work",
      updateIssueToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("PATCH", `/issues/${encodeURIComponent(issueId)}`, { body }),
    ),
    makeTool(
      "checkout_issue",
      "Checkout an issue for an agent",
      checkoutIssueToolSchema,
      async ({ issueId, agentId, expectedStatuses }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/checkout`, {
          body: {
            agentId: client.resolveAgentId(agentId),
            expectedStatuses: expectedStatuses ?? ["todo", "backlog", "blocked"],
          },
        }),
    ),
    makeTool(
      "release_issue",
      "Release an issue checkout",
      z.object({ issueId: issueIdSchema }),
      async ({ issueId }) => client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/release`, { body: {} }),
    ),
    makeTool(
      "add_comment",
      "Add a comment to an issue; include resume=true when intentionally requesting follow-up on resumable closed work",
      addCommentToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/comments`, { body }),
    ),
    makeTool(
      "suggest_tasks",
      "Create a suggest_tasks interaction on an issue",
      createSuggestTasksToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/interactions`, {
          body: {
            kind: "suggest_tasks",
            ...body,
          },
        }),
    ),
    makeTool(
      "ask_user_questions",
      "Create an ask_user_questions interaction on an issue",
      createAskUserQuestionsToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/interactions`, {
          body: {
            kind: "ask_user_questions",
            ...body,
          },
        }),
    ),
    makeTool(
      "request_confirmation",
      "Create a request_confirmation interaction on an issue",
      createRequestConfirmationToolSchema,
      async ({ issueId, ...body }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/interactions`, {
          body: {
            kind: "request_confirmation",
            ...body,
          },
        }),
    ),
    makeTool(
      "upsert_issue_document",
      "Create or update an issue document",
      upsertDocumentToolSchema,
      async ({ issueId, key, ...body }) =>
        client.requestJson(
          "PUT",
          `/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}`,
          { body },
        ),
    ),
    makeTool(
      "restore_issue_document_revision",
      "Restore a prior revision of an issue document",
      z.object({
        issueId: issueIdSchema,
        key: documentKeySchema,
        revisionId: z.string().uuid(),
      }),
      async ({ issueId, key, revisionId }) =>
        client.requestJson(
          "POST",
          `/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}/revisions/${encodeURIComponent(revisionId)}/restore`,
          { body: {} },
        ),
    ),
    makeTool(
      "link_issue_approval",
      "Link an approval to an issue",
      z.object({ issueId: issueIdSchema }).merge(linkIssueApprovalSchema),
      async ({ issueId, approvalId }) =>
        client.requestJson("POST", `/issues/${encodeURIComponent(issueId)}/approvals`, {
          body: { approvalId },
        }),
    ),
    makeTool(
      "unlink_issue_approval",
      "Unlink an approval from an issue",
      z.object({ issueId: issueIdSchema, approvalId: approvalIdSchema }),
      async ({ issueId, approvalId }) =>
        client.requestJson(
          "DELETE",
          `/issues/${encodeURIComponent(issueId)}/approvals/${encodeURIComponent(approvalId)}`,
        ),
    ),
    makeTool(
      "approval_decision",
      "Approve, reject, request revision, or resubmit an approval",
      approvalDecisionSchema,
      async ({ approvalId, action, decisionNote, payloadJson }) => {
        const path =
          action === "approve"
            ? `/approvals/${encodeURIComponent(approvalId)}/approve`
            : action === "reject"
              ? `/approvals/${encodeURIComponent(approvalId)}/reject`
              : action === "requestRevision"
                ? `/approvals/${encodeURIComponent(approvalId)}/request-revision`
                : `/approvals/${encodeURIComponent(approvalId)}/resubmit`;

        const body =
          action === "resubmit"
            ? { payload: parseOptionalJson(payloadJson) ?? {} }
            : { decisionNote };

        return client.requestJson("POST", path, { body });
      },
    ),
    makeTool(
      "add_approval_comment",
      "Add a comment to an approval",
      z.object({ approvalId: approvalIdSchema, body: z.string().min(1) }),
      async ({ approvalId, body }) =>
        client.requestJson("POST", `/approvals/${encodeURIComponent(approvalId)}/comments`, {
          body: { body },
        }),
    ),
    // Bug filing, as a tool rather than a form.
    //
    // The report that actually helps is the one written where the failure
    // happened, by whoever (or whatever) was holding the context at the time.
    // Asking a person to stop, open a browser, find the repo and retype what
    // just went wrong loses most of that — so most of it never gets filed.
    // "Tell your agent to file a bug" keeps the context, because the agent
    // still has the command it ran and the error it got back.
    //
    // The tool is deliberately thin: no repo, no labels, no owner. Those are
    // instance configuration, and an agent that had to guess them would file
    // into the wrong place with confidence.
    makeTool(
      "report_issue",
      "File a bug report or feature request as a GitHub issue on the AgentDash team's queue. Use this when the user says something like 'file a bug' or 'report this', or when you hit a defect worth recording. Include what you were doing, what you expected, what happened, and the exact error — you have that context and the user should not have to retype it.",
      z.object({
        kind: z
          .enum(["bug", "feature"])
          .describe("bug for something broken, feature for something missing"),
        title: z
          .string()
          .trim()
          .min(3)
          .max(160)
          .describe("One line naming the specific failure, not the area it is in"),
        description: z
          .string()
          .trim()
          .min(10)
          .max(8000)
          .describe(
            "What you were doing, what you expected, what happened instead, and the verbatim error or response. Markdown is fine.",
          ),
        companyId: companyIdOptional,
      }),
      async ({ kind, title, description, companyId }) =>
        client.requestJson("POST", "/issue-reports", {
          body: {
            kind,
            title,
            description,
            // Server-side actors override this; sending it is only meaningful
            // for a board credential driving the tool on a person's behalf.
            ...(companyId ? { companyId } : {}),
          },
        }),
    ),
    makeTool(
      "report_issue_status",
      "Check whether issue reporting is configured on this instance, and which GitHub repo reports land in. Call this before telling a user their bug was filed somewhere.",
      z.object({}),
      async () => client.requestJson("GET", "/issue-reports/config"),
    ),
    makeTool(
      "api_request",
      "Make a JSON request to an existing AgentDash /api endpoint for unsupported operations",
      apiRequestSchema,
      async ({ method, path, jsonBody }) => {
        if (!path.startsWith("/") || path.includes("..")) {
          throw new Error("path must start with / and be relative to /api, and must not contain '..'");
        }
        return client.requestJson(method, path, {
          body: parseOptionalJson(jsonBody),
        });
      },
    ),
    // ---- AgentDash: company provisioning + Chief-of-Staff onboarding ----
    // Lets agents/humans create and set up a workspace through the LLM-led CoS,
    // reducing onboarding friction. Marked with the agentdash* prefix to keep
    // these AgentDash extensions distinct from inherited paperclip* tools.
    makeTool(
      "agentdashBootstrapWorkspace",
      "AgentDash: provision a workspace for the authenticated user — creates the company, a Chief of Staff agent, and the opening conversation. The lowest-friction way to start onboarding. Takes no input.",
      z.object({}),
      async () => client.requestJson("POST", "/onboarding/bootstrap", { body: {} }),
    ),
    makeTool(
      "agentdashListCompanies",
      "AgentDash: list the companies (workspaces) the authenticated actor can access",
      z.object({}),
      async () => client.requestJson("GET", "/companies"),
    ),
    makeTool(
      "agentdashGetCompany",
      "AgentDash: get a company (workspace) by id",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) =>
        client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}`),
    ),
    makeTool(
      "agentdashCreateCompany",
      "AgentDash: explicitly create a new company (workspace). For full onboarding prefer agentdashBootstrapWorkspace, which also provisions a Chief of Staff.",
      createCompanySchema,
      async (body) => client.requestJson("POST", "/companies", { body }),
    ),
    makeTool(
      "agentdashCosChat",
      "AgentDash: send a message to a company's Chief of Staff (drives the onboarding interview). The CoS reply is generated asynchronously — call agentdashReadConversation shortly after to read it. Returns the posted message, including its conversationId.",
      cosChatToolSchema,
      async ({ companyId, message }) => {
        const cid = client.resolveCompanyId(companyId);
        const inbox = await client.requestJson<{ id: string }>(
          "GET",
          `/conversations/companies/${cid}/inbox`,
        );
        return client.requestJson(
          "POST",
          `/conversations/${encodeURIComponent(inbox.id)}/messages`,
          { body: { body: message, companyId: cid } },
        );
      },
    ),
    makeTool(
      "agentdashReadConversation",
      "AgentDash: read recent messages in a conversation (e.g. to fetch the Chief of Staff's reply after agentdashCosChat)",
      readConversationToolSchema,
      async ({ conversationId, limit }) => {
        const qs = limit ? `?limit=${limit}` : "";
        return client.requestJson(
          "GET",
          `/conversations/${encodeURIComponent(conversationId)}/messages${qs}`,
        );
      },
    ),
    makeTool(
      "agentdashHireAgent",
      "AgentDash: hire an agent into a company (e.g. agents the Chief of Staff proposes during onboarding). adapterType selects the runtime (e.g. claude_code, hermes_local).",
      hireAgentToolSchema,
      async ({ companyId, ...body }) =>
        client.requestJson(
          "POST",
          `/companies/${client.resolveCompanyId(companyId)}/agent-hires`,
          { body },
        ),
    ),
  ];
}
