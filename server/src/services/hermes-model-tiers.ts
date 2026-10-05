// AgentDash (review-1028, item 1): the hermes_local model tiers are opt-in
// per instance and BYOK-aware. Everything that auto-applies a tier —
// agent creation, CoS chat dispatch, hire-card payloads, healer
// suggestions — must ask `hermesModelTiersActive()` first.
//
// Two conditions, both required:
//   1. AGENTDASH_HERMES_MODEL_TIERS=on — an operator opted this instance
//      in (HQ, MK, the token-plan boxes). Default off: with the switch off,
//      hermes_local behaves exactly as before — Hermes' own configured
//      provider/model answers, no forced `--provider`.
//   2. No BYOK provider key on the box. `configureHermesProvider` writes a
//      marker into the template profile when a company sets up its own
//      model key; forcing `alibaba-token-plan-cn` onto that key's agents
//      would break them, so a configured marker disables the tiers even
//      with the switch on.
//
// The pure half (tier resolution, role mapping, explicit-config precedence)
// lives in packages/shared/src/hermes-model-tiers.ts.
import {
  applyHermesModelTierDefault,
  HERMES_LOCAL_ADAPTER_TYPE,
  hermesModelTiersEnabled,
  hermesTierOverrideWarnings,
  mapProposedAgentRole,
  modelTierForRole,
  proposedRoleTitle,
  resolveHermesModelTier,
  type AgentPlanProposalV1Payload,
  type HermesModelTierId,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { hermesProviderConfiguredSync } from "./hermes-provider-setup.js";

let overrideWarningsLogged = false;

/**
 * Whether the instance should be applying model tiers at all: the env
 * switch is on AND the box does not hold a company's own provider key.
 * Pass `env` in tests — `HERMES_PROFILES_DIR`/`AGENTDASH_HERMES_ROOT`
 * point the BYOK marker check away from the real Hermes home.
 */
export function hermesModelTiersActive(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!hermesModelTiersEnabled(env)) return false;
  if (!overrideWarningsLogged) {
    overrideWarningsLogged = true;
    for (const warning of hermesTierOverrideWarnings(env)) {
      logger.warn(`[hermes-model-tiers] ${warning}`);
    }
  }
  return !hermesProviderConfiguredSync(env);
}

/**
 * `applyHermesModelTierDefault` plus the instance gate: inactive returns
 * the config untouched and no tier, which is exactly the pre-tier behaviour.
 */
export function applyHermesModelTierIfActive(input: {
  adapterType: string | null | undefined;
  adapterConfig: Record<string, unknown> | null | undefined;
  role: string | null | undefined;
  title?: string | null;
  env?: NodeJS.ProcessEnv;
}): { adapterConfig: Record<string, unknown>; appliedTier: HermesModelTierId | null } {
  if (!hermesModelTiersActive(input.env)) {
    return { adapterConfig: { ...(input.adapterConfig ?? {}) }, appliedTier: null };
  }
  return applyHermesModelTierDefault(input);
}

/**
 * The model+tier a proposal card may promise for a hire: resolved here, on
 * the server, so the card shows what THIS instance would apply — env
 * overrides included — rather than recomputing from the shipped defaults in
 * the UI. Null when the tiers are inactive or the adapter is not
 * hermes_local; cards fall back to their pre-tier look then.
 */
export function hermesModelTierStamp(input: {
  adapterType: string | null | undefined;
  role: string | null | undefined;
  title?: string | null;
  env?: NodeJS.ProcessEnv;
}): { modelTier: HermesModelTierId; model: string } | null {
  if (input.adapterType !== HERMES_LOCAL_ADAPTER_TYPE || !hermesModelTiersActive(input.env)) {
    return null;
  }
  // Same mapping the hire paths use: `mapProposedAgentRole` for the role
  // enum, `proposedRoleTitle(title ?? role)` for the title — the card must
  // promise exactly what materialization applies.
  const tier = modelTierForRole(
    mapProposedAgentRole(input.role ?? ""),
    proposedRoleTitle(input.title?.trim() || input.role || ""),
  );
  return { modelTier: tier, model: resolveHermesModelTier(tier, input.env).model };
}

/**
 * Stamp the resolved model+tier onto each hermes_local agent in a plan-card
 * payload. Returns the payload untouched when tiers are inactive, so a card
 * written on an off-instance looks exactly like a pre-tier card.
 */
export function stampPlanModelTiers(plan: AgentPlanProposalV1Payload): AgentPlanProposalV1Payload {
  if (!hermesModelTiersActive()) return plan;
  let changed = false;
  const agents = plan.agents.map((agent) => {
    const stamp = hermesModelTierStamp({
      adapterType: agent.adapterType,
      role: agent.role,
      title: agent.title,
    });
    if (!stamp) return agent;
    changed = true;
    return { ...agent, ...stamp };
  });
  return changed ? { ...plan, agents } : plan;
}
