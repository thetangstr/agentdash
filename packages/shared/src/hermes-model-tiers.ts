// AgentDash (batch 4, lane c4-model-tiers, founder decision 2026-10-04): one
// shared source of truth for the hermes_local high–low model defaults.
//
// HIGH — "Qwen 3.8 Max" — serves the leadership roles (Chief of Staff, CEO,
// PM, CTO and lead-engineering roles). LOW — "DeepSeek V4.1 Flash" — serves
// every other agent (ops/execution). Both are routed through the Alibaba
// Token Plan (China) provider in Hermes (`alibaba-token-plan-cn`).
//
// Operators can swap either tier's model/provider without a release via env:
//   AGENTDASH_HERMES_HIGH_MODEL / AGENTDASH_HERMES_HIGH_PROVIDER
//   AGENTDASH_HERMES_LOW_MODEL  / AGENTDASH_HERMES_LOW_PROVIDER
//
// An explicit `adapterConfig.model` (and `adapterConfig.provider`) chosen by a
// person always wins — `applyHermesModelTierDefault` only fills an empty one.

export const HERMES_MODEL_TIERS = {
  high: {
    provider: "alibaba-token-plan-cn",
    model: "qwen3.8-max-0902",
    displayName: "Qwen 3.8 Max",
    tierLabel: "high tier",
  },
  low: {
    provider: "alibaba-token-plan-cn",
    model: "deepseek-v4-flash",
    // DeepSeek routes this id to V4.1 Flash.
    displayName: "DeepSeek V4.1 Flash",
    // "ops tier", not "low tier", on people-facing surfaces.
    tierLabel: "ops tier",
  },
} as const;

export type HermesModelTierId = keyof typeof HERMES_MODEL_TIERS;

export const HERMES_LOCAL_ADAPTER_TYPE = "hermes_local";

/** `agent.metadata.modelTier` records which tier default was applied. */
export const AGENT_MODEL_TIER_METADATA_KEY = "modelTier";

const TIER_ENV_KEYS: Record<HermesModelTierId, { model: string; provider: string }> = {
  high: { model: "AGENTDASH_HERMES_HIGH_MODEL", provider: "AGENTDASH_HERMES_HIGH_PROVIDER" },
  low: { model: "AGENTDASH_HERMES_LOW_MODEL", provider: "AGENTDASH_HERMES_LOW_PROVIDER" },
};

export interface HermesModelTierSpec {
  provider: string;
  model: string;
  displayName: string;
  tierLabel: string;
}

function envOrDefault(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return env ?? (typeof process !== "undefined" && process.env ? process.env : {});
}

/**
 * The effective spec for a tier: shipped values plus the instance env
 * overrides. `displayName` only describes the shipped model ids — an
 * overridden model is shown as its raw id rather than under a false name.
 */
export function resolveHermesModelTier(
  tier: HermesModelTierId,
  env?: NodeJS.ProcessEnv,
): HermesModelTierSpec {
  const base = HERMES_MODEL_TIERS[tier];
  const keys = TIER_ENV_KEYS[tier];
  const resolved = envOrDefault(env);
  const model = (resolved[keys.model] ?? "").trim() || base.model;
  const provider = (resolved[keys.provider] ?? "").trim() || base.provider;
  return {
    provider,
    model,
    displayName: model === base.model ? base.displayName : model,
    tierLabel: base.tierLabel,
  };
}

// ---------------------------------------------------------------------------
// modelTierForRole
// ---------------------------------------------------------------------------

// High by role enum. "reviewer" and friends deliberately fall to low.
const HIGH_TIER_ROLES: ReadonlySet<string> = new Set([
  "chief_of_staff",
  "ceo",
  "pm",
  "cto",
]);

// High by title. A plan/hire card keeps the proposed wording as the title even
// when the role enum strips it ("Chief of Staff" hires as `general`), so the
// title carries the real signal. Matching is word-bounded on the normalized
// title (lowercased, non-alphanumeric collapsed to a single space).
const HIGH_TIER_TITLE_PATTERNS: readonly RegExp[] = [
  /\bchief of staff\b/,
  /\bchief executive(?:\s+officer)?\b/,
  /\bceo\b/,
  /\bchief technolog(?:y|ical)\s+officer\b/,
  /\bcto\b/,
  /\bpm\b/,
  /\bproduct manager\b/,
  /\bproduct lead\b/,
  /\bhead of product\b/,
  /\blead engineer\b/,
  /\bengineering lead\b/,
  /\bhead of engineering\b/,
  /\bengineering manager\b/,
  /\bvp(?:\s+of)?\s+engineering\b/,
  /\bvice president(?:\s+of)?\s+engineering\b/,
  /\bdirector of engineering\b/,
  /\bengineering director\b/,
  /\btech(?:nical)?\s+lead\b/,
];

function normalizeTierText(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Which tier an agent gets: `high` for leadership roles (Chief of Staff, CEO,
 * PM, CTO and lead-engineering roles, matched on the role enum AND on titles
 * like "Lead Engineer", "Engineering Lead", "Head of Engineering"), `low`
 * for everything else.
 */
export function modelTierForRole(
  role: string | null | undefined,
  title?: string | null,
): HermesModelTierId {
  const normalizedRole = normalizeTierText(role).replace(/\s+/g, "_");
  if (HIGH_TIER_ROLES.has(normalizedRole)) return "high";
  const normalizedTitle = normalizeTierText(title);
  if (normalizedTitle && HIGH_TIER_TITLE_PATTERNS.some((pattern) => pattern.test(normalizedTitle))) {
    return "high";
  }
  return "low";
}

// ---------------------------------------------------------------------------
// Applying the default
// ---------------------------------------------------------------------------

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Stamp the tier's model/provider onto a hermes_local adapterConfig that has
 * no explicit model. An explicit `model` (or `provider`) a person set always
 * wins and is reported back as `appliedTier: null` — the agent is then on
 * custom configuration, not a tier.
 */
export function applyHermesModelTierDefault(input: {
  adapterType: string | null | undefined;
  adapterConfig: Record<string, unknown> | null | undefined;
  role: string | null | undefined;
  title?: string | null;
  env?: NodeJS.ProcessEnv;
}): { adapterConfig: Record<string, unknown>; appliedTier: HermesModelTierId | null } {
  const adapterConfig = { ...(input.adapterConfig ?? {}) };
  if (input.adapterType !== HERMES_LOCAL_ADAPTER_TYPE) {
    return { adapterConfig, appliedTier: null };
  }
  if (nonEmptyString(adapterConfig.model)) {
    return { adapterConfig, appliedTier: null };
  }
  const tier = modelTierForRole(input.role, input.title);
  const spec = resolveHermesModelTier(tier, input.env);
  adapterConfig.model = spec.model;
  if (!nonEmptyString(adapterConfig.provider)) {
    adapterConfig.provider = spec.provider;
  }
  return { adapterConfig, appliedTier: tier };
}

// ---------------------------------------------------------------------------
// Display helpers (shared by the agent page, hire cards and the doctor CLI)
// ---------------------------------------------------------------------------

/** Plain-words name for a shipped model id; null for everything else. */
export function hermesModelDisplayName(model: string | null | undefined): string | null {
  const trimmed = (model ?? "").trim();
  if (!trimmed) return null;
  for (const tier of Object.values(HERMES_MODEL_TIERS)) {
    if (tier.model === trimmed) return tier.displayName;
  }
  return null;
}

/** "high tier" / "ops tier" for a tier id; null for anything else. */
export function hermesModelTierLabel(tier: string | null | undefined): string | null {
  return tier === "high" || tier === "low" ? HERMES_MODEL_TIERS[tier].tierLabel : null;
}

/**
 * Which tier a model id belongs to, under the resolved (env-overridden)
 * tier specs. Lets surfaces label an agent that predates
 * `metadata.modelTier` — the recorded value always wins when present.
 */
export function hermesModelTierForModel(
  model: string | null | undefined,
  env?: NodeJS.ProcessEnv,
): HermesModelTierId | null {
  const trimmed = (model ?? "").trim();
  if (!trimmed) return null;
  for (const tier of ["high", "low"] as const) {
    if (resolveHermesModelTier(tier, env).model === trimmed) return tier;
  }
  return null;
}

/**
 * The plain-words model line: "Qwen 3.8 Max · high tier" /
 * "DeepSeek V4.1 Flash · ops tier". Returns null when there is nothing
 * useful to say (no model, or a custom model with no tier).
 */
export function describeHermesModel(input: {
  model: string | null | undefined;
  modelTier?: string | null;
  env?: NodeJS.ProcessEnv;
}): { text: string; rawTitle: string } | null {
  const model = (input.model ?? "").trim();
  if (!model) return null;
  const tier = hermesModelTierLabel(input.modelTier) ?? null;
  const inferredTier = input.modelTier ? null : hermesModelTierForModel(model, input.env);
  const tierText = tier ?? (inferredTier ? hermesModelTierLabel(inferredTier) : null);
  const name = hermesModelDisplayName(model) ?? model;
  return {
    text: tierText ? `${name} · ${tierText}` : name,
    rawTitle: model,
  };
}
