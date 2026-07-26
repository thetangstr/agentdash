import { z } from "zod";
import { PaperclipApiClient } from "./client.js";
import { makeTool, type ToolDefinition } from "./tools.js";

// ---------------------------------------------------------------------------
// AgentDash journey tools: install → onboard → provision → operate.
//
// These tools power the launch journey: a coding agent on a fresh machine
// installs AgentDash, runs the deep-interview onboarding to capture customer
// intent, provisions the company + agent team, and keeps operating
// goal-oriented and self-driving — while risky actions are gated behind
// human approval in the AgentDash UI (see src/playbook.ts).
// ---------------------------------------------------------------------------

const PLAN_CARD_KIND = "agent_plan_proposal_v1";
const COS_ROLE = "chief_of_staff";

const companyIdOptional = z.string().uuid().optional().nullable();

// ---------------------------------------------------------------------------
// Self-driving anchor: the setup-status state machine
// ---------------------------------------------------------------------------

export interface SetupStatusSnapshot {
  /** GET /health succeeded. */
  serverHealthy: boolean;
  /**
   * bootstrapStatus from the (unauthenticated) /health payload —
   * "bootstrap_pending" means an authenticated-mode instance with no
   * instance admin yet, i.e. a fresh install nobody has claimed. Null when
   * the server doesn't report one (local_trusted / older servers).
   */
  bootstrapStatus: string | null;
  /** A model adapter is configured (claude/openai/gemini key, or stub mode). */
  adapterReady: boolean;
  /** A bearer API key is configured on this MCP session. */
  apiKeyConfigured: boolean;
  /** Company id from config or the first listed company; null when none. */
  companyId: string | null;
  /** Total agents in the company (incl. the Chief of Staff). */
  agentCount: number;
  /** Agents whose role is not chief_of_staff (i.e. the materialized team). */
  nonCosAgentCount: number;
  /** Agents currently paused. */
  pausedAgentCount: number;
  /** A plan card (agent_plan_proposal_v1) exists but the team is not materialized. */
  planReady: boolean;
  /** Pending approvals count. */
  pendingApprovals: number;
  /** Open (not done/cancelled) tasks count. */
  openTasks: number;
}

export type SetupPhase =
  | "install"
  | "sign_up"
  | "setup_adapter"
  | "bootstrap"
  | "interview"
  | "plan_review"
  | "paused"
  | "operate";

export interface NextAction {
  phase: SetupPhase;
  nextAction: string;
  nextActionReason: string;
}

/**
 * Deterministic state machine mapping a setup-status snapshot to the single
 * next action the calling agent should take. Pure — unit-testable without
 * any network access.
 */
export function computeNextAction(snapshot: SetupStatusSnapshot): NextAction {
  if (!snapshot.serverHealthy) {
    return {
      phase: "install",
      nextAction: "agentdash_install_checklist",
      nextActionReason:
        "The AgentDash server is unreachable. Run the install checklist / start the server "
        + "(steps run in your shell with the human's consent), then re-check agentdash_setup_status.",
    };
  }
  // AgentDash (MCP-native signup): a healthy authenticated-mode server that
  // reports bootstrap_pending has no founding user yet. With no API key on
  // this session, the ONLY forward path is signing the human up — every
  // authenticated tool would 401. Sign-up mints the board key in-session.
  if (snapshot.bootstrapStatus === "bootstrap_pending" && !snapshot.apiKeyConfigured) {
    return {
      phase: "sign_up",
      nextAction: "agentdash_sign_up",
      nextActionReason:
        "The server is a fresh authenticated-mode install with no founding user, and this "
        + "session has no API key. Ask the human for their email and name (NEVER invent an "
        + "email), then call agentdash_sign_up — it creates the founding user, returns a board "
        + "API key, and signs this session in.",
    };
  }
  // Adapter gate: the deep-interview follow-ups + the agent-team plan are
  // driven by a real model. If no adapter is configured yet, route the human
  // through model setup BEFORE the interview so its questions are intelligent.
  // Uses the (unauthenticated) /health adapterReady flag, so this works even
  // on a fresh post-signup session.
  if (!snapshot.adapterReady) {
    return {
      phase: "setup_adapter",
      nextAction: "agentdash_setup_adapter",
      nextActionReason:
        "A model adapter is not configured yet. Ask the human which provider to run agents on "
        + "(Claude / OpenAI / Gemini — they'll need an API key — or 'stub' for a no-key "
        + "placeholder), then call agentdash_setup_adapter. The interview cannot produce a real "
        + "team plan until this is set.",
    };
  }
  if (!snapshot.companyId || snapshot.agentCount === 0) {
    return {
      phase: "bootstrap",
      nextAction: "agentdash_start_interview",
      nextActionReason:
        "Server is healthy but no workspace (or no Chief of Staff) exists yet. "
        + "Bootstrap the company + Chief of Staff and begin the onboarding interview.",
    };
  }
  const planConfirmed = snapshot.nonCosAgentCount > 0;
  if (!planConfirmed && !snapshot.planReady) {
    return {
      phase: "interview",
      nextAction: "agentdash_interview_turn",
      nextActionReason:
        "The onboarding interview is incomplete — no team plan has been proposed yet. "
        + "Continue the interview with the user's answers until a plan card appears.",
    };
  }
  if (!planConfirmed && snapshot.planReady) {
    return {
      phase: "plan_review",
      nextAction: "agentdash_confirm_plan",
      nextActionReason:
        "A team plan is proposed but unconfirmed. Present it to the human, then "
        + "agentdash_confirm_plan (requires human approval if hires are gated) or agentdash_revise_plan.",
    };
  }
  if (snapshot.agentCount > 0 && snapshot.pausedAgentCount >= snapshot.agentCount) {
    return {
      phase: "paused",
      nextAction: "agentdash_request_approval",
      nextActionReason:
        "All agents are paused. Resuming the fleet is a gated action: request approval, "
        + "wait until agentdash_check_approval returns approved, then agentdash_resume_agent.",
    };
  }
  return {
    phase: "operate",
    nextAction: "agentdash_list_tasks / agentdash_create_task",
    nextActionReason:
      "The workspace is provisioned and agents are available. Operate: review tasks with "
      + "agentdash_list_tasks, create work with agentdash_create_task, and re-check "
      + "agentdash_setup_status after each action.",
  };
}

// ---------------------------------------------------------------------------
// Install checklist (data only — never executed by this server)
// ---------------------------------------------------------------------------

export interface InstallStep {
  id: string;
  run: string;
  verify: string;
  expect: string;
}

export const INSTALL_STEPS: InstallStep[] = [
  {
    id: "prerequisites",
    run: "node --version && pnpm --version",
    verify: "node --version",
    expect: "Node.js v20+ and pnpm 9+ are installed (install via `brew install node pnpm` if missing)",
  },
  {
    id: "clone",
    run: "git clone https://github.com/thetangstr/agentdash.git ~/agentdash",
    verify: "ls ~/agentdash/package.json",
    expect: "~/agentdash/package.json exists",
  },
  {
    id: "install-deps",
    run: "cd ~/agentdash && pnpm install",
    verify: "ls ~/agentdash/node_modules",
    expect: "pnpm install completes without errors and node_modules exists",
  },
  {
    id: "launchd-install",
    run: "cd ~/agentdash && ./docker/launchd/install.sh",
    verify: "launchctl print gui/$(id -u)/ai.agentdash.agent | head -5",
    expect: "the ai.agentdash.agent launchd service is loaded",
  },
  {
    id: "env-file",
    run: "open -e ~/.config/agentdash/agentdash.env  # set deployment mode, adapter, API keys",
    verify: "cat ~/.config/agentdash/agentdash.env",
    expect: "env file contains your configuration (e.g. PAPERCLIP_DEPLOYMENT_MODE, AGENTDASH_DEFAULT_ADAPTER)",
  },
  {
    id: "restart-service",
    run: "launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent",
    verify: "sleep 5 && curl -fsS http://localhost:3100/api/health",
    expect: "health endpoint returns HTTP 200 with a JSON body",
  },
  {
    id: "health-check",
    run: "curl -fsS http://localhost:3100/api/health",
    verify: "curl -fsS http://localhost:3100/api/health",
    expect: '{"status":"ok",...} — the AgentDash server is up on http://localhost:3100',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    : [];
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

interface ConversationMessage extends Record<string, unknown> {
  cardKind?: string | null;
  cardPayload?: Record<string, unknown> | null;
  createdAt?: string;
}

/** Pick the latest agent_plan_proposal_v1 message from a message list. */
export function findLatestPlanMessage(messages: unknown): ConversationMessage | null {
  const planMessages = asArray(messages).filter(
    (message) => message.cardKind === PLAN_CARD_KIND,
  ) as ConversationMessage[];
  if (planMessages.length === 0) return null;
  return [...planMessages].sort((a, b) => {
    const aTs = typeof a.createdAt === "string" ? a.createdAt : "";
    const bTs = typeof b.createdAt === "string" ? b.createdAt : "";
    return aTs.localeCompare(bTs);
  })[planMessages.length - 1] ?? null;
}

async function fetchConversationMessages(
  client: PaperclipApiClient,
  conversationId: string,
): Promise<Array<Record<string, unknown>>> {
  const messages = await client.requestJson(
    "GET",
    `/conversations/${encodeURIComponent(conversationId)}/messages?limit=200`,
  );
  return asArray(messages);
}

// ---------------------------------------------------------------------------
// Journey tool definitions
// ---------------------------------------------------------------------------

export function createJourneyToolDefinitions(client: PaperclipApiClient): ToolDefinition[] {
  return [
    makeTool(
      "agentdash_setup_status",
      "THE SELF-DRIVING ANCHOR. Aggregates server health, agents, dashboard, and pending "
        + "approvals into a machine-readable status with a deterministic nextAction. Call this "
        + "first, do the nextAction, verify, and call it again — repeat until the workspace is "
        + "provisioned and operating.",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId: inputCompanyId }) => {
        // /health is unauthenticated even in authenticated deployments, so
        // setup_status works with no API key configured — that is exactly
        // the state where it must route to agentdash_sign_up.
        let serverHealthy = false;
        let bootstrapStatus: string | null = null;
        let adapterReady = false;
        try {
          const health = await client.requestJson<Record<string, unknown>>("GET", "/health");
          serverHealthy = true;
          bootstrapStatus =
            health && typeof health.bootstrapStatus === "string" ? health.bootstrapStatus : null;
          // AgentDash: adapter readiness is on /health so it's readable
          // unauthenticated (pre-signup) — exactly when the gate must fire.
          adapterReady = health?.adapterReady === true;
        } catch {
          serverHealthy = false;
        }

        // Every fetch below requires a bearer credential — skip them all
        // when the session has no key (they would only 401).
        const apiKeyConfigured = client.hasApiKey;

        let companyId = inputCompanyId?.trim() || client.defaults.companyId || null;
        if (serverHealthy && apiKeyConfigured && !companyId) {
          try {
            const companies = asArray(await client.requestJson("GET", "/companies"));
            companyId = readString(companies[0] ?? {}, "id");
          } catch {
            companyId = null;
          }
        }

        let agents: Array<Record<string, unknown>> = [];
        let dashboard: Record<string, unknown> | null = null;
        let pendingApprovals = 0;
        if (serverHealthy && apiKeyConfigured && companyId) {
          try {
            agents = asArray(await client.requestJson("GET", `/companies/${companyId}/agents`));
          } catch {
            agents = [];
          }
          try {
            const summary = await client.requestJson("GET", `/companies/${companyId}/dashboard`);
            dashboard = summary && typeof summary === "object" ? summary as Record<string, unknown> : null;
          } catch {
            dashboard = null;
          }
          try {
            const approvals = asArray(
              await client.requestJson("GET", `/companies/${companyId}/approvals?status=pending`),
            );
            pendingApprovals = approvals.length;
          } catch {
            const fromDashboard = dashboard?.pendingApprovals;
            pendingApprovals = typeof fromDashboard === "number" ? fromDashboard : 0;
          }
        }

        const nonCosAgents = agents.filter((agent) => agent.role !== COS_ROLE);
        const pausedAgentCount = agents.filter((agent) => agent.status === "paused").length;

        // Only pay for the plan-card lookup while the team is unmaterialized —
        // that's the only window where interview-vs-plan_review is ambiguous.
        let planReady = false;
        if (serverHealthy && apiKeyConfigured && companyId && agents.length > 0 && nonCosAgents.length === 0) {
          try {
            const inbox = await client.requestJson<{ id: string }>(
              "GET",
              `/conversations/companies/${companyId}/inbox`,
            );
            const messages = await fetchConversationMessages(client, inbox.id);
            planReady = findLatestPlanMessage(messages) !== null;
          } catch {
            planReady = false;
          }
        }

        const taskCounts = dashboard?.taskCounts as Record<string, unknown> | undefined;
        const openTasks = typeof taskCounts?.open === "number" ? taskCounts.open : 0;

        const snapshot: SetupStatusSnapshot = {
          serverHealthy,
          bootstrapStatus,
          adapterReady,
          apiKeyConfigured,
          companyId,
          agentCount: agents.length,
          nonCosAgentCount: nonCosAgents.length,
          pausedAgentCount,
          planReady,
          pendingApprovals,
          openTasks,
        };
        const next = computeNextAction(snapshot);

        return {
          phase: next.phase,
          serverHealthy,
          bootstrapStatus,
          adapterReady,
          apiKeyConfigured,
          companyId,
          agentCount: agents.length,
          runningAgents: agents.length - pausedAgentCount,
          pendingApprovals,
          openTasks,
          nextAction: next.nextAction,
          nextActionReason: next.nextActionReason,
        };
      },
    ),
    makeTool(
      "agentdash_install_checklist",
      "Returns machine-readable install steps for AgentDash on a fresh Mac mini. "
        + "This tool NEVER executes anything. The steps run in the calling agent's shell "
        + "with the human's consent — run them one at a time and verify each before the next.",
      z.object({}),
      async () => ({
        notice:
          "This tool NEVER executes anything. The steps run in the calling agent's shell "
          + "with the human's consent.",
        steps: INSTALL_STEPS,
        afterInstall:
          "When the health check passes, call agentdash_setup_status — it will route you to "
          + "agentdash_sign_up (fresh authenticated install) or agentdash_start_interview.",
      }),
    ),
    makeTool(
      "agentdash_sign_up",
      "Founding-user signup for a FRESH authenticated-mode install — works ONLY while the "
        + "instance has zero users (bootstrapStatus \"bootstrap_pending\"). No password needed: "
        + "collect the human's email and name in conversation (NEVER invent an email), and the "
        + "server creates the founding user, returns a board API key, and this session continues "
        + "authenticated immediately. Persist the key so future sessions stay signed in.",
      z.object({
        email: z.string().email(),
        name: z.string().min(1).max(120),
        inviteCode: z
          .string()
          .min(1)
          .max(120)
          .optional()
          .describe(
            "AgentDash invite code. Most installs require one — ask the human for it "
            + "(NEVER invent or guess a code). If signup answers invite_code_required, "
            + "collect the code and retry.",
          ),
      }),
      async ({ email, name, inviteCode }) => {
        const result = await client.requestJson<{
          userId: string;
          email: string;
          name: string;
          apiKey: string;
          apiKeyExpiresAt: string;
          passwordSetup: string;
        }>("POST", "/onboarding/mcp-signup", { body: { email, name, inviteCode } });

        // Upgrade THIS session in place: every subsequent tool call carries
        // the new board key without an MCP server restart.
        client.setApiKey(result.apiKey);

        return {
          userId: result.userId,
          email: result.email,
          apiKey: result.apiKey,
          apiKeyExpiresAt: result.apiKeyExpiresAt,
          apiKeyPersistInstructions:
            `Add PAPERCLIP_API_KEY=${result.apiKey} to the MCP server env so future sessions `
            + "stay signed in",
          passwordSetup: result.passwordSetup,
        };
      },
    ),
    makeTool(
      "agentdash_setup_adapter",
      "Configure the model adapter your agents will run on — a required onboarding step before the "
        + "interview can produce a real team plan. Offer the human the choices from the preset menu "
        + "(Claude / OpenAI / Gemini — each needs an API key — or 'stub' for a no-key placeholder that "
        + "produces canned plans). Ask the human which provider and collect the key in conversation "
        + "(NEVER invent a key). After applying, re-check agentdash_setup_status to confirm "
        + "adapterReady before continuing the interview.",
      z.object({
        preset: z
          .enum(["claude", "openai", "gemini", "stub"])
          .describe(
            "claude=ANTHROPIC_API_KEY; openai=OPENAI_COMPAT_API_KEY (api.openai.com); "
              + "gemini=OPENAI_COMPAT_API_KEY (Gemini OpenAI-compat); stub=no key, canned plans.",
          ),
        apiKey: z
          .string()
          .min(1)
          .max(400)
          .optional()
          .describe(
            "The provider API key. Required for claude/openai/gemini. Omit for stub. "
              + "Collected from the human — NEVER invented.",
          ),
      }),
      async ({ preset, apiKey }) => {
        const result = await client.requestJson<{
          status: { adapter: string; ready: boolean; preset: string; reason: string | null };
          applied: string[];
          persisted: boolean;
          persistError: string | null;
        }>("POST", "/onboarding/setup-adapter", {
          body: { preset, ...(apiKey ? { apiKey } : {}) },
        });
        return {
          preset,
          adapter: result.status.adapter,
          ready: result.status.ready,
          applied: result.applied,
          persisted: result.persisted,
          ...(result.persistError ? { persistError: result.persistError } : {}),
          next:
            "Re-check agentdash_setup_status. If adapterReady is true, continue the interview with "
            + "agentdash_interview_turn (the follow-ups + team plan will now use the real model).",
        };
      },
    ),
    makeTool(
      "agentdash_start_interview",
      "Bootstrap the AgentDash workspace: creates the company, the Chief of Staff agent, and the "
        + "onboarding conversation, then enforces the boundary default that new agent hires require "
        + "board approval. Returns {companyId, conversationId, cosAgentId, boundaries}. Follow with "
        + "agentdash_interview_turn to run the intent-capture interview.",
      z.object({}),
      async () => {
        const bootstrap = await client.requestJson<{
          companyId: string;
          cosAgentId: string;
          conversationId: string;
        }>("POST", "/onboarding/bootstrap", { body: {} });

        // Boundary default: hires beyond the confirmed plan must be gated
        // behind human approval in the AgentDash UI.
        let requiredManualStep: string | null = null;
        try {
          await client.requestJson("PATCH", `/companies/${bootstrap.companyId}`, {
            body: { requireBoardApprovalForNewAgents: true },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          requiredManualStep =
            "REQUIRED: could not set requireBoardApprovalForNewAgents=true automatically "
            + `(${message}). A board user must PATCH /api/companies/${bootstrap.companyId} `
            + 'with {"requireBoardApprovalForNewAgents": true}, or enable "Require board approval '
            + 'for new agents" in the AgentDash company settings, before any agents are hired.';
        }

        return {
          companyId: bootstrap.companyId,
          conversationId: bootstrap.conversationId,
          cosAgentId: bootstrap.cosAgentId,
          boundaries: { hiresRequireApproval: true },
          ...(requiredManualStep ? { requiredManualStep } : {}),
        };
      },
    ),
    makeTool(
      "agentdash_interview_turn",
      "Submit one round of the onboarding interview: passes the user's answer to the Chief of "
        + "Staff and returns the next question (or the completed state). Repeat until a team plan "
        + "is proposed, then use agentdash_get_plan.",
      z.object({
        conversationId: z.string().uuid(),
        userMessage: z.string().min(1),
        cosAgentId: z.string().uuid().optional().nullable(),
        companyId: companyIdOptional,
      }),
      async ({ conversationId, userMessage, cosAgentId, companyId }) =>
        client.requestJson("POST", "/onboarding/interview/turn", {
          body: {
            conversationId,
            userMessage,
            cosAgentId: cosAgentId ?? undefined,
            companyId: companyId ?? client.defaults.companyId ?? undefined,
          },
        }),
    ),
    makeTool(
      "agentdash_get_plan",
      "Fetch the latest proposed agent-team plan (the newest agent_plan_proposal_v1 card in the "
        + "onboarding conversation). Present the plan to the human before confirming.",
      z.object({ conversationId: z.string().uuid() }),
      async ({ conversationId }) => {
        const messages = await fetchConversationMessages(client, conversationId);
        const planMessage = findLatestPlanMessage(messages);
        if (!planMessage) {
          return {
            planFound: false,
            hint:
              "No agent_plan_proposal_v1 card in this conversation yet — continue the interview "
              + "with agentdash_interview_turn.",
          };
        }
        return {
          planFound: true,
          messageId: planMessage.id ?? null,
          createdAt: planMessage.createdAt ?? null,
          body: planMessage.body ?? null,
          plan: planMessage.cardPayload ?? null,
        };
      },
    ),
    makeTool(
      "agentdash_confirm_plan",
      "Confirm and materialize the proposed agent team from the latest plan card. Creates one "
        + "agent per plan entry. Only call this after the human has approved the plan. Hires beyond "
        + "this confirmed plan are gated — use agentdash_request_approval for those.",
      z.object({ conversationId: z.string().uuid() }),
      async ({ conversationId }) =>
        client.requestJson("POST", "/onboarding/confirm-plan", {
          body: { conversationId },
        }),
    ),
    makeTool(
      "agentdash_revise_plan",
      "Request revisions to the proposed agent-team plan. Pass the human's feedback; the Chief of "
        + "Staff rewrites the plan as a delta and posts a new plan card.",
      z.object({
        conversationId: z.string().uuid(),
        revisionText: z.string().min(1).max(4000),
      }),
      async ({ conversationId, revisionText }) =>
        client.requestJson("POST", "/onboarding/revise-plan", {
          body: { conversationId, revisionText },
        }),
    ),
    makeTool(
      "agentdash_request_approval",
      "Request human approval for a gated action (hiring beyond the plan, deletions, budget "
        + "changes, pausing/resuming the fleet, anything outside the confirmed goals). Creates a "
        + "request_board_approval that the human decides at the approveUrl in the AgentDash UI. "
        + "Returns {approvalId, status, approveUrl}. Poll agentdash_check_approval and do NOT "
        + "proceed until it returns approved.",
      z.object({
        companyId: companyIdOptional,
        summary: z.string().min(1).max(500),
        proposedAction: z.string().min(1).max(2000),
        details: z.string().max(10000).optional(),
        issueIds: z.array(z.string().uuid()).optional(),
      }),
      async ({ companyId, summary, proposedAction, details, issueIds }) => {
        const resolvedCompanyId = client.resolveCompanyId(companyId);
        const approval = await client.requestJson<{ id: string; status: string }>(
          "POST",
          `/companies/${resolvedCompanyId}/approvals`,
          {
            body: {
              type: "request_board_approval",
              ...(client.defaults.agentId ? { requestedByAgentId: client.defaults.agentId } : {}),
              payload: {
                summary,
                proposedAction,
                ...(details ? { details } : {}),
                requestedVia: "mcp",
              },
              ...(issueIds && issueIds.length > 0 ? { issueIds } : {}),
            },
          },
        );
        return {
          approvalId: approval.id,
          status: approval.status ?? "pending",
          approveUrl: `${client.appBaseUrl}/approvals/${approval.id}`,
        };
      },
    ),
    makeTool(
      "agentdash_check_approval",
      "Check the status of an approval request. Poll this after agentdash_request_approval and DO "
        + "NOT proceed with the gated action until status === \"approved\". If status is "
        + "\"rejected\" or \"revision_requested\", read the comments (paperclipListApprovalComments) "
        + "and either revise the request or drop the action. Never fabricate approval status.",
      z.object({ approvalId: z.string().uuid() }),
      async ({ approvalId }) => {
        const approval = await client.requestJson<Record<string, unknown>>(
          "GET",
          `/approvals/${encodeURIComponent(approvalId)}`,
        );
        return {
          approvalId,
          status: approval.status ?? null,
          decisionNote: approval.decisionNote ?? null,
          approved: approval.status === "approved",
        };
      },
    ),
    makeTool(
      "agentdash_list_agents",
      "List all agents in the workspace with their current status (read-only, always allowed).",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) =>
        client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/agents`),
    ),
    makeTool(
      "agentdash_list_tasks",
      "List tasks/issues in the workspace, optionally filtered by status (read-only, always allowed).",
      z.object({
        companyId: companyIdOptional,
        status: z
          .enum(["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"])
          .optional(),
      }),
      async ({ companyId, status }) => {
        const qs = status ? `?status=${encodeURIComponent(status)}` : "";
        return client.requestJson(
          "GET",
          `/companies/${client.resolveCompanyId(companyId)}/issues${qs}`,
        );
      },
    ),
    makeTool(
      "agentdash_create_task",
      "Create a new task/issue in the workspace and optionally assign it to an agent. Creating "
        + "tasks within the confirmed goals is always allowed — it is also the fallback when an "
        + "approval stays pending: create a task for the human instead of proceeding.",
      z.object({
        companyId: companyIdOptional,
        title: z.string().min(1),
        description: z.string().optional(),
        priority: z.enum(["critical", "high", "medium", "low"]).optional().default("medium"),
        assigneeAgentId: z.string().uuid().optional().nullable(),
      }),
      async ({ companyId, title, description, priority, assigneeAgentId }) =>
        client.requestJson("POST", `/companies/${client.resolveCompanyId(companyId)}/issues`, {
          body: {
            title,
            description: description ?? "",
            priority,
            status: "todo",
            ...(assigneeAgentId ? { assigneeAgentId } : {}),
          },
        }),
    ),
    makeTool(
      "agentdash_get_dashboard",
      "Get the company dashboard summary: agent counts, task counts, spend, pending approvals "
        + "(read-only, always allowed).",
      z.object({ companyId: companyIdOptional }),
      async ({ companyId }) =>
        client.requestJson("GET", `/companies/${client.resolveCompanyId(companyId)}/dashboard`),
    ),
    makeTool(
      "agentdash_pause_agent",
      "Pause one agent so it stops picking up new work. GATED when applied to ALL agents: "
        + "pausing the whole fleet requires agentdash_request_approval first — wait for approved.",
      z.object({ agentId: z.string().uuid() }),
      async ({ agentId }) =>
        client.requestJson("POST", `/agents/${encodeURIComponent(agentId)}/pause`, { body: {} }),
    ),
    makeTool(
      "agentdash_resume_agent",
      "Resume a paused agent. GATED: resuming an agent a human paused, or resuming the whole "
        + "fleet, requires agentdash_request_approval first — wait until agentdash_check_approval "
        + "returns approved before calling this.",
      z.object({ agentId: z.string().uuid() }),
      async ({ agentId }) =>
        client.requestJson("POST", `/agents/${encodeURIComponent(agentId)}/resume`, { body: {} }),
    ),
  ];
}
