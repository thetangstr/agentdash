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
import { HERMES_LOCAL_ADAPTER_TYPE, hermesModelTierForModel, resolveHermesModelTier } from "@paperclipai/shared";
import { hermesModelTiersActive } from "../hermes-model-tiers.js";

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
// AgentDash (batch 4, c4-model-tiers): a hermes_local agent's recovery
// suggestion moves within Hermes first — the high–low tier pair, resolved
// per call so env overrides are honoured — before crossing providers.
// `adapter:model` entries match the AGENTDASH_FALLBACK_CHAIN hop format;
// the first entry that is not the agent's current (adapter, model) is what
// gets suggested.
const ADAPTER_FALLBACK_CHAIN: Record<string, string[]> = {
  claude_local: ["claude_api", "opencode_local", "hermes_local"],
  claude_api: ["opencode_local", "hermes_local"],
  codex_local: ["opencode_local"],
  gemini_local: ["claude_api", "opencode_local"],
  opencode_local: ["hermes_local"],
  pi_local: ["claude_api", "opencode_local"],
  acpx_local: ["claude_api"],
  openclaw_gateway: ["claude_api"],
};

// AgentDash (review-1028, item 8): the hermes_local hops are computed, not
// constant — env-resolved tier models, and only while the tiers are active
// on this instance (suggesting a provider that is not configured is not a
// suggestion). Cross-provider `claude_api` stays last either way.
function hermesLocalFallbackChain(): string[] {
  const hops: string[] = [];
  if (hermesModelTiersActive()) {
    hops.push(`hermes_local:${resolveHermesModelTier("high").model}`);
    hops.push(`hermes_local:${resolveHermesModelTier("low").model}`);
  }
  hops.push("claude_api");
  return hops;
}

function fallbackChainForAdapter(adapterType: string): string[] {
  if (adapterType === HERMES_LOCAL_ADAPTER_TYPE) return hermesLocalFallbackChain();
  return ADAPTER_FALLBACK_CHAIN[adapterType] ?? [];
}

/**
 * Where an operator-configured chain or the built-in table WOULD have moved
 * this agent — the suggestion that rides in the escalation. An
 * AGENTDASH_FALLBACK_CHAIN takes precedence; otherwise the built-in table,
 * whose hermes_local entries carry `adapter:model` so "the high tier" and
 * "the low tier" are distinct hops. The hop the agent already sits on is
 * skipped (a suggestion must be a real move), and when the agent's provider
 * IS one of the tier providers the other tier hop is skipped too — the
 * failure is provider-level then (the token plan itself is down) and a
 * different model on the same provider is the same call again, so the
 * suggestion goes to the cross-provider hop.
 */
export function suggestHealerFallbackTarget(input: {
  adapterType: string;
  model: string;
  provider: string;
}): string | null {
  const envChain = readFallbackChain();
  if (envChain.length > 0) {
    const next = nextFallbackHop(envChain, { adapter: input.adapterType, model: input.model });
    return next ? `${next.adapter}${next.model ? `:${next.model}` : ""}` : null;
  }
  const fallbackChain = fallbackChainForAdapter(input.adapterType);
  const currentProvider = input.provider.trim();
  const tierProviders = new Set(
    (["high", "low"] as const).map((tier) => resolveHermesModelTier(tier).provider),
  );
  return (
    fallbackChain.find((hop) => {
      const sep = hop.indexOf(":");
      const hopAdapter = sep < 0 ? hop : hop.slice(0, sep);
      const hopModel = sep < 0 ? "" : hop.slice(sep + 1);
      if (hopAdapter === input.adapterType && hopModel === input.model) return false;
      if (
        currentProvider
        && tierProviders.has(currentProvider)
        && hopModel
        && hermesModelTierForModel(hopModel)
      ) return false;
      return true;
    }) ?? null
  );
}

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

    const suggestedTarget = suggestHealerFallbackTarget({
      adapterType: currentAdapter,
      model: currentModel,
      provider:
        typeof currentConfig.provider === "string" ? currentConfig.provider : "",
    });

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
