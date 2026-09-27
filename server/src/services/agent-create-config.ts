import { AGENT_DEFAULT_MAX_CONCURRENT_RUNS } from "@paperclipai/shared";

/**
 * AgentDash: the new-agent runtimeConfig normalization the person-facing
 * create and hire routes apply — extracted here (GH #679 review) so the
 * assistant hire path runs the SAME normalization rather than a lookalike.
 * Pure and dependency-free on purpose: it fills policy defaults, it does not
 * validate the host environment.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseBooleanLike(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }
  return null;
}

function parseNumberLike(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Default the heartbeat policy for a newly created/hired agent: heartbeat off
 * unless explicitly enabled, and a max-concurrency cap present even when the
 * caller sent nothing. Bit-identical to the version that lived inside
 * `routes/agents.ts`.
 */
export function normalizeNewAgentRuntimeConfig(runtimeConfig: unknown): Record<string, unknown> {
  const parsedRuntimeConfig = asRecord(runtimeConfig);
  const normalizedRuntimeConfig = parsedRuntimeConfig ? { ...parsedRuntimeConfig } : {};
  const parsedHeartbeat = asRecord(normalizedRuntimeConfig.heartbeat);
  const heartbeat = parsedHeartbeat ? { ...parsedHeartbeat } : {};

  if (parseBooleanLike(heartbeat.enabled) == null) {
    heartbeat.enabled = false;
  }
  if (parseNumberLike(heartbeat.maxConcurrentRuns) == null) {
    heartbeat.maxConcurrentRuns = AGENT_DEFAULT_MAX_CONCURRENT_RUNS;
  }

  normalizedRuntimeConfig.heartbeat = heartbeat;
  return normalizedRuntimeConfig;
}
