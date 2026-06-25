// AgentDash native adapter (`agentdash_native`).
//
// A first-party, in-process agent runtime: no external binary, no venv, no shell,
// no filesystem. It runs the agent loop inside the server process against the
// managed inference gateway, and acts on the world ONLY through typed tools that
// wrap the AgentDash REST API (authed with the per-run JWT). This eliminates the
// failure classes seen with external harnesses: provider-token setup, missing
// binary / version drift, runaway timeouts, EPIPE crash-loops, and live-source
// mutation (there is no fs/shell tool to misuse).
//
// Design: doc/plans/2026-06-24-gateway-and-native-adapter-design.md (Part B).

import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterModel,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import {
  GatewayConfigError,
  computeGatewayCostUsd,
  isGatewayConfigured,
  listGatewayModels,
  resolveGatewayAccess,
} from "../../services/inference-gateway.js";
import { PaperclipApi } from "./paperclip-api.js";
import { buildTools } from "./tools.js";
import { runAgentLoop } from "./loop.js";

const DEFAULT_MAX_TURNS = 30;
const DEFAULT_TIMEOUT_SEC = 600; // 10 min — well under the 1800s that caused runaway timeouts

function asNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}
function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function buildSystemPrompt(agentName: string): string {
  return [
    `You are ${agentName}, an AI agent employed in an AgentDash company.`,
    "You act ONLY through the provided tools. You have NO shell, filesystem, or browser.",
    "Workflow: read your assigned issue (get_issue), do the work by reasoning, then record the outcome —",
    "post a concise summary with add_comment, and set the issue status with update_issue_status",
    "('done' when complete, 'blocked' if you cannot proceed, 'in_review' if it needs review).",
    "Use the other tools as appropriate: list_comments, list_issues, list_agents, create_sub_issue,",
    "set_dod, write_verdict, create_interaction (to ask the user / suggest tasks / request confirmation),",
    "get_quota, and request_approval for actions needing human sign-off.",
    "Be concise and decisive. Do not loop indefinitely — finish by commenting and setting status.",
  ].join(" ");
}

export const agentDashNativeAdapter: ServerAdapterModule = {
  type: "agentdash_native",
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  requiresMaterializedRuntimeSkills: false,

  models: listGatewayModels() as AdapterModel[],

  async testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
    const configured = isGatewayConfigured();
    return {
      adapterType: "agentdash_native",
      status: configured ? "pass" : "fail",
      testedAt: new Date(0).toISOString(),
      checks: [
        configured
          ? {
              code: "gateway_configured",
              level: "info",
              message: "Inference gateway is configured (base URL + key present).",
            }
          : {
              code: "gateway_not_configured",
              level: "error",
              message: "Inference gateway is not configured.",
              hint: "Set AGENTDASH_GATEWAY_BASE_URL and AGENTDASH_GATEWAY_API_KEY (or a per-company BYO key).",
            },
      ],
    };
  },

  async execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
    const config = (ctx.config ?? {}) as Record<string, unknown>;
    const companyId = ctx.agent.companyId;

    // Resolve model access through the gateway — no customer token needed.
    let access;
    try {
      access = resolveGatewayAccess({ companyId, requestedModel: asString(config.model) ?? null });
    } catch (err) {
      const message = err instanceof GatewayConfigError ? err.message : `gateway resolution failed: ${String(err)}`;
      return { exitCode: 1, signal: null, timedOut: false, errorCode: "gateway_not_configured", errorMessage: message };
    }

    if (!ctx.authToken) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "adapter_failed",
        errorMessage: "missing per-run agent token (ctx.authToken)",
      };
    }

    const issue = (ctx.context?.paperclipIssue ?? null) as { id?: string } | null;
    const currentIssueId = issue?.id ?? asString(ctx.context?.issueId) ?? null;

    const api = new PaperclipApi({ authToken: ctx.authToken, runId: ctx.runId });
    const tools = buildTools({
      api,
      agentId: ctx.agent.id,
      companyId,
      currentIssueId,
      autoApprove: false,
    });

    const userPrompt = renderPaperclipWakePrompt(ctx.context?.paperclipWake, {
      resumedSession: Boolean(ctx.runtime?.sessionId),
    });

    const loop = await runAgentLoop({
      baseUrl: access.baseUrl,
      apiKey: access.apiKey,
      model: access.model,
      systemPrompt: buildSystemPrompt(ctx.agent.name),
      userPrompt: userPrompt && userPrompt.length > 0 ? userPrompt : "Begin working on your assigned issue.",
      tools,
      maxTurns: asNumber(config.maxTurns, DEFAULT_MAX_TURNS),
      timeoutMs: asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC) * 1000,
      onLog: ctx.onLog,
    });

    const usage = {
      inputTokens: loop.usage.inputTokens,
      outputTokens: loop.usage.outputTokens,
      cachedInputTokens: loop.usage.cachedInputTokens,
    };
    const costUsd = computeGatewayCostUsd(access.canonicalModel, usage);
    const base = {
      usage,
      costUsd,
      provider: access.provider,
      biller: access.provider,
      // Gateway inference is pay-per-use -> metered_api so it lands in costEvents
      // for the usage-based SKU (heartbeat reads result.billingType + costUsd).
      billingType: "metered_api",
      model: access.canonicalModel,
      signal: null,
      summary: loop.finalText ? loop.finalText.slice(0, 1000) : null,
    } as const;

    switch (loop.stopReason) {
      case "completed":
        return { ...base, exitCode: 0, timedOut: false };
      case "timeout":
        return { ...base, exitCode: null, timedOut: true, errorCode: "timeout", errorMessage: "agent loop exceeded its time budget" };
      case "max_turns":
        return { ...base, exitCode: 1, timedOut: false, errorCode: "max_turns", errorMessage: "agent loop reached its max-turns budget" };
      case "error":
      default:
        return { ...base, exitCode: 1, timedOut: false, errorCode: "adapter_failed", errorMessage: loop.errorMessage ?? "agent loop error" };
    }
  },
};

export default agentDashNativeAdapter;
