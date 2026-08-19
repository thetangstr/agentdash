import { AGENT_ADAPTER_TYPES } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

/**
 * AgentDash: operator-configured adapter fallback chain.
 *
 * `AGENTDASH_FALLBACK_CHAIN` is an ordered list of hops tried after the
 * primary adapter fails, written as comma-separated `adapter[:model]`
 * entries, e.g.:
 *
 *   AGENTDASH_FALLBACK_CHAIN=hermes_local:k3,hermes_local:glm-5.3
 *
 * Two hops may name the same adapter with different models — that is the
 * point: "Kimi K3 via Hermes, then GLM via Hermes" is one adapter, two hops.
 * A hop without a model runs the adapter on its own configured default.
 *
 * The chain is read from the environment on every call, like
 * AGENTDASH_MK_INVITE_CODES, so an operator can change it with an env edit
 * and a restart and tests can set it per-case.
 *
 * Unset (or empty after validation) means "no chain": callers fall back to
 * their previous behavior — the single-hop AGENTDASH_FALLBACK_ADAPTER for
 * chat dispatch, the built-in adapter table for the run-healer.
 */
export interface FallbackHop {
  adapter: string;
  model?: string;
}

const KNOWN_ADAPTERS: readonly string[] = AGENT_ADAPTER_TYPES;

export function readFallbackChain(): FallbackHop[] {
  const raw = (process.env.AGENTDASH_FALLBACK_CHAIN ?? "").trim();
  if (!raw) return [];
  const hops: FallbackHop[] = [];
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(":");
    const adapter = (sep < 0 ? trimmed : trimmed.slice(0, sep)).trim();
    const model = sep < 0 ? "" : trimmed.slice(sep + 1).trim();
    if (!KNOWN_ADAPTERS.includes(adapter)) {
      // Skip-and-log rather than throw: one typo'd hop should not disable the
      // valid hops after it, and this runs inside failure handling where a
      // second failure would mask the original error.
      logger.warn(
        { entry: trimmed, adapter },
        "[fallback-chain] ignoring hop with unknown adapter type",
      );
      continue;
    }
    hops.push(model ? { adapter, model } : { adapter });
  }
  return hops;
}

/**
 * Where in the chain is the caller now, and what comes next?
 *
 * The current position is matched by (adapter, model) — model `null`,
 * `undefined` and `""` are the same "adapter default" position. An agent that
 * matches no hop is on its primary configuration, so the next hop is the
 * first; an agent sitting on the last hop has nowhere left to go.
 *
 * Matching takes the LAST occurrence so a chain that revisits an earlier
 * (adapter, model) pair — pathological, but expressible — still terminates
 * instead of cycling.
 */
export function nextFallbackHop(
  chain: FallbackHop[],
  current: { adapter: string | null; model?: string | null },
): FallbackHop | null {
  if (chain.length === 0) return null;
  const currentAdapter = (current.adapter ?? "").trim();
  const currentModel = (current.model ?? "").trim();
  let position = -1;
  for (let i = 0; i < chain.length; i++) {
    const hop = chain[i];
    if (hop.adapter === currentAdapter && (hop.model ?? "").trim() === currentModel) {
      position = i;
    }
  }
  const next = position < 0 ? chain[0] : chain[position + 1];
  if (!next) return null;
  // A "next" hop identical to where the caller already is cannot help.
  if (next.adapter === currentAdapter && (next.model ?? "").trim() === currentModel) {
    return null;
  }
  return next;
}
