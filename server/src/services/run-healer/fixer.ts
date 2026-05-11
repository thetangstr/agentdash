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

// Adapter fallback chain: if one fails, try the next
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
  try {
    // Get current agent info including companyId
    const [agent] = await db
      .select({ companyId: agents.companyId, adapterType: agents.adapterType })
      .from(agents)
      .where(eq(agents.id, run.agentId));
    if (!agent) {
      return { succeeded: false, actionTaken: "agent_not_found", costUsd: 0 };
    }

    const currentAdapter = agent.adapterType ?? "claude_local";
    const fallbackChain = ADAPTER_FALLBACK_CHAIN[currentAdapter] ?? [];

    if (fallbackChain.length === 0) {
      logger.info({ runId: run.id, currentAdapter }, "run_healer: no fallback adapters available");
      return { succeeded: false, actionTaken: "no_fallback_available", costUsd: 0 };
    }

    const targetAdapter = fallbackChain[0];
    logger.info({ runId: run.id, from: currentAdapter, to: targetAdapter, reason: diagnosis.diagnosis }, "run_healer: switching adapter");

    // Update agent's adapter type
    await db
      .update(agents)
      .set({ adapterType: targetAdapter })
      .where(eq(agents.id, run.agentId));

    // Re-enqueue the run with the new adapter
    const { agentWakeupRequests } = await import("@paperclipai/db");
    await db.insert(agentWakeupRequests).values({
      companyId: agent.companyId,
      agentId: run.agentId,
      source: "automation",
      reason: "healer_adapter_switch",
      triggerDetail: `healer_switched_from_${currentAdapter}_to_${targetAdapter}`,
    });

    return {
      succeeded: true,
      actionTaken: `adapter_switch_${currentAdapter}_to_${targetAdapter}`,
      costUsd: 0,
    };
  } catch (err) {
    logger.error({ runId: run.id, error: err }, "run_healer: adapter switch failed");
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
