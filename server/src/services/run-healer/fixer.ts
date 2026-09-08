/**
 * Fix executor for the run healer.
 *
 * Takes a HealDiagnosis and applies the appropriate fix within safety bounds.
 */

import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, healAttempts } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { logger } from "../../middleware/logger.js";
import type { HealDiagnosis } from "./diagnosis.js";
import { heartbeatService } from "../heartbeat.js";
import { agentService } from "../agents.js";
import { nextFallbackHop, readFallbackChain } from "../../lib/adapter-fallback-chain.js";

/**
 * AGE-113 invariant: automatic recovery may not switch an agent's adapter or
 * model. The built-in table and the env chain below are RETAINED as references
 * for what a human may configure, and their hop logic (`nextFallbackHop`) is
 * still used to report where an operator-configured chain WOULD have gone, but
 * nothing here writes `agents.adapterType` or `adapterConfig.model` anymore.
 *
 * The healer's `adapter_switch` diagnosis is therefore executed as an
 * ESCALATION: the run is re-enqueued once on the agent's own configuration
 * (a bounded retry, the same wakeup the `retry` fix uses), and the failure is
 * surfaced so a human can decide whether to change the configuration.
 */
const ADAPTER_FALLBACK_CHAIN: Record<string, string[]> = {
  claude_local: ["claude_api", "opencode_local", "hermes_local"],
  claude_api: ["opencode_local", "hermes_local"],
  codex_local: ["opencode_local"],
  gemini_local: ["claude_api", "opencode_local"],
  opencode_local: ["hermes_local"],
  hermes_local: ["claude_api"],
  pi_local: ["claude_api", "opencode_local"],
  acpx_local: ["claude_api"],
  openclaw_gateway: ["claude_api"],
};

export type HealFixResult = {
  succeeded: boolean;
  actionTaken: string;
  costUsd: number;
};

export async function executeHealFix(
  db: Db,
  run: {
    id: string;
    agentId: string;
    status: string;
    errorCode: string | null;
  },
  diagnosis: HealDiagnosis,
): Promise<HealFixResult> {
  switch (diagnosis.fixType) {
    case "retry":
      return await executeRetryFix(db, run, diagnosis);
    case "adapter_switch":
      return await executeAdapterSwitchFix(db, run, diagnosis);
    case "config_update":
      return await executeConfigUpdateFix(db, run, diagnosis);
    case "manual_required":
      return { succeeded: false, actionTaken: "manual_required", costUsd: 0 };
    default:
      return { succeeded: false, actionTaken: "unknown_fix_type", costUsd: 0 };
  }
}

async function executeRetryFix(
  db: Db,
  run: { id: string; agentId: string },
  _diagnosis: HealDiagnosis,
): Promise<HealFixResult> {
  try {
    // Get agent's companyId for the wakeup request
    const [agent] = await db
      .select({ companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.id, run.agentId));
    if (!agent) {
      return { succeeded: false, actionTaken: "agent_not_found", costUsd: 0 };
    }

    const { agentWakeupRequests } = await import("@paperclipai/db");
    await db.insert(agentWakeupRequests).values({
      companyId: agent.companyId,
      agentId: run.agentId,
      source: "automation",
      reason: "healer_retry",
      triggerDetail: "healer_retry",
    });

    logger.info({ runId: run.id }, "run_healer: retry enqueued");
    return { succeeded: true, actionTaken: "retry_enqueued", costUsd: 0 };
  } catch (err) {
    logger.error({ runId: run.id, error: err }, "run_healer: retry failed");
    return { succeeded: false, actionTaken: "retry_failed", costUsd: 0 };
  }
}

async function executeAdapterSwitchFix(
  db: Db,
  run: { id: string; agentId: string; errorCode: string | null },
  diagnosis: HealDiagnosis,
): Promise<HealFixResult> {
  // AGE-113: an adapter_switch diagnosis may not change the agent's adapter
  // or model. Automatic recovery's job here is to (a) re-enqueue the run once
  // on the agent's OWN configuration — the provider may have recovered, and a
  // retry costs nothing — and (b) surface the failure for a human decision.
  // What changed in behavior terms: the switch write below is gone. What did
  // NOT change: the run still gets exactly one more attempt, still bounded by
  // maxHealsPerRun/maxHealsPerDay.
  try {
    // Read (never write) the agent's configuration, and compute where an
    // operator-configured chain or the legacy table WOULD have moved it, so
    // the escalation carries actionable detail for the human.
    const [agent] = await db
      .select({
        companyId: agents.companyId,
        adapterType: agents.adapterType,
        adapterConfig: agents.adapterConfig,
      })
      .from(agents)
      .where(eq(agents.id, run.agentId));
    if (!agent) {
      return { succeeded: false, actionTaken: "agent_not_found", costUsd: 0 };
    }

    const currentAdapter = agent.adapterType ?? "claude_local";
    const currentConfig = (agent.adapterConfig ?? {}) as Record<string, unknown>;
    const currentModel = typeof currentConfig.model === "string" ? currentConfig.model : "";

    let suggestedTarget: string | null = null;
    const envChain = readFallbackChain();
    if (envChain.length > 0) {
      const next = nextFallbackHop(envChain, { adapter: currentAdapter, model: currentModel });
      suggestedTarget = next ? `${next.adapter}${next.model ? `:${next.model}` : ""}` : null;
    } else {
      const fallbackChain = ADAPTER_FALLBACK_CHAIN[currentAdapter] ?? [];
      if (fallbackChain.length > 0) suggestedTarget = fallbackChain[0] ?? null;
    }

    logger.warn(
      {
        runId: run.id,
        agentId: run.agentId,
        currentAdapter,
        currentModel: currentModel || null,
        suggestedTarget,
        reason: diagnosis.diagnosis,
      },
      "run_healer: adapter_switch requested — invariant refuses the switch; retrying on the agent's own configuration and escalating to a human",
    );

    // Bounded retry on the agent's own configuration. Same wakeup shape the
    // `retry` fix uses; the run keeps its adapter, model and billing identity.
    const { agentWakeupRequests } = await import("@paperclipai/db");
    await db.insert(agentWakeupRequests).values({
      companyId: agent.companyId,
      agentId: run.agentId,
      source: "automation",
      reason: "healer_retry",
      triggerDetail: "healer_adapter_switch_refused_retry_on_own_config",
    });

    return {
      succeeded: true,
      actionTaken: `adapter_switch_refused_escalated_retry_on_${currentAdapter}${currentModel ? `:${currentModel}` : ""}`,
      costUsd: 0,
    };
  } catch (err) {
    logger.error({ runId: run.id, error: err }, "run_healer: adapter switch handling failed");
    return { succeeded: false, actionTaken: "adapter_switch_failed", costUsd: 0 };
  }
}

async function executeConfigUpdateFix(
  db: Db,
  run: { id: string; agentId: string; errorCode: string | null },
  diagnosis: HealDiagnosis,
): Promise<HealFixResult> {
  try {
    // Get agent's companyId for the wakeup request
    const [agent] = await db
      .select({ companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.id, run.agentId));
    if (!agent) {
      return { succeeded: false, actionTaken: "agent_not_found", costUsd: 0 };
    }

    // Clear session for the agent (if the issue is session-related)
    const { agentRuntimeState } = await import("@paperclipai/db");
    await db
      .delete(agentRuntimeState)
      .where(and(eq(agentRuntimeState.agentId, run.agentId)));

    logger.info({ runId: run.id, reason: diagnosis.diagnosis }, "run_healer: session cleared");

    // Re-enqueue the run
    const { agentWakeupRequests } = await import("@paperclipai/db");
    await db.insert(agentWakeupRequests).values({
      companyId: agent.companyId,
      agentId: run.agentId,
      source: "automation",
      reason: "healer_session_clear",
      triggerDetail: "healer_cleared_session",
    });

    return { succeeded: true, actionTaken: "session_cleared_and_retry", costUsd: 0 };
  } catch (err) {
    logger.error({ runId: run.id, error: err }, "run_healer: config update failed");
    return { succeeded: false, actionTaken: "config_update_failed", costUsd: 0 };
  }
}
