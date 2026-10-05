// AgentDash (batch 4, lane c4-model-tiers, founder decision 2026-10-04): one
// shared source of truth for the hermes_local high–low model defaults.
//
// HIGH — "Qwen 3.8 Max" — serves the leadership roles (Chief of Staff, CEO,
// PM, CTO and lead-engineering roles). LOW — "DeepSeek V4.1 Flash" — serves
// every other agent (ops/execution). Both are routed through the Alibaba
// Token Plan (China) provider in Hermes (`alibaba-token-plan-cn`).
//
// AgentDash (review-1028): the tiers are OPT-IN per instance. They apply
// only when AGENTDASH_HERMES_MODEL_TIERS=on AND the box is not on a
// company's own model key — the server-side gate
// (server/src/services/hermes-model-tiers.ts) checks both, and this module
// only carries the primitive half (`hermesModelTiersEnabled`). With the
// switch off, hermes_local behaves exactly as before: Hermes' own
// configured provider/model answers, no forced `--provider`.
//
// Operators can swap either tier's model/provider without a release via env:
//   AGENTDASH_HERMES_HIGH_MODEL / AGENTDASH_HERMES_HIGH_PROVIDER
//   AGENTDASH_HERMES_LOW_MODEL  / AGENTDASH_HERMES_LOW_PROVIDER
// Setting only the *_MODEL half keeps the shipped Alibaba provider — almost
// never the intent; `hermesTierOverrideWarnings` reports an unpaired
// override so the operator sees it instead of discovering it in billing.
//
// An explicit `adapterConfig.model` (and `adapterConfig.provider`) chosen by
// a person always wins — `applyHermesModelTierDefault` only fills an empty
// one, and an explicit provider that is not the tier's counts as a person's
// choice too, not a gap to fill around.

export const HERMES_MODEL_TIERS = {
  high: {
    provider: "alibaba-token-plan-cn",
    model: "qwen3.8-max",
    displayName: "Qwen 3.8 Max",
    tierLabel: "high tier",
  },
  low: {
    provider: "alibaba-token-plan-cn",
    model: "deepseek-v4.1-flash",
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

/**
 * The opt-in switch: exactly `on` enables the tiers on an instance; unset,
 * `off`, or anything else leaves hermes_local on Hermes' own configured
 * provider/model — the pre-tier behaviour.
 */
export const HERMES_MODEL_TIERS_ENV = "AGENTDASH_HERMES_MODEL_TIERS";

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

/** True only when the operator opted this instance in: `AGENTDASH_HERMES_MODEL_TIERS=on`. */
export function hermesModelTiersEnabled(env?: NodeJS.ProcessEnv): boolean {
  return (envOrDefault(env)[HERMES_MODEL_TIERS_ENV] ?? "").trim().toLowerCase() === "on";
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

/**
 * Pairing mistakes worth surfacing: overriding only a tier's *_MODEL keeps
 * the shipped Alibaba provider (and only *_PROVIDER keeps the shipped
 * model) — almost never the intent. One warning per unpaired override.
 */
export function hermesTierOverrideWarnings(env?: NodeJS.ProcessEnv): string[] {
  const resolved = envOrDefault(env);
  const warnings: string[] = [];
  for (const tier of ["high", "low"] as const) {
    const keys = TIER_ENV_KEYS[tier];
    const modelSet = Boolean((resolved[keys.model] ?? "").trim());
    const providerSet = Boolean((resolved[keys.provider] ?? "").trim());
    if (modelSet === providerSet) continue;
    warnings.push(
      modelSet
        ? `${keys.model} is set without ${keys.provider} — the ${tier} tier still routes to ` +
            `${HERMES_MODEL_TIERS[tier].provider}. Set the provider var too.`
        : `${keys.provider} is set without ${keys.model} — the ${tier} tier still runs ` +
            `${HERMES_MODEL_TIERS[tier].model}. Set the model var too.`,
    );
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// modelTierForRole
// ---------------------------------------------------------------------------

// The role enum alone decides only for the two roles a proposal cannot
// water down: a hire filed as `ceo` or `chief_of_staff` is leadership by
// definition. `pm`/`cto` are different — `mapProposedAgentRole` also parks
// project/program/scrum/coordinator/delivery proposals in `pm` and
// architect/tech-lead proposals in `cto`, and those are execution, not
// leadership. For pm/cto the enum decides only when no title exists; a
// present title has to confirm leadership (below).
const HIGH_TIER_ROLES: ReadonlySet<string> = new Set([
  "chief_of_staff",
  "ceo",
]);

const LEADERSHIP_TITLE_ROLES: ReadonlySet<string> = new Set([
  "pm",
  "cto",
]);

// High by title — leadership wording only. A plan/hire card keeps the
// proposed wording as the title even when the role enum strips it
// ("Chief of Staff" hires as `general`), so the title carries the real
// signal. Matching is on the normalized title (lowercased,
// non-alphanumeric collapsed to a single space).
//
// The patterns are deliberately tighter than "contains the keyword":
// C-level abbreviations only match the whole title, so "Executive Assistant
// to the CEO" and "CEO Office Coordinator" are ops; product leadership
// patterns end at the leadership word, so "Head of Product Marketing" is
// marketing, not product; and the engineering-lead patterns anchor at the
// start, so "Sales Engineering Lead" and "Customer Success Engineering
// Manager" are sales/CS, not engineering leadership.
const HIGH_TIER_TITLE_PATTERNS: readonly RegExp[] = [
  /^chief of staff\b/,
  /^(?:chief executive(?:\s+officer)?|ceo)$/,
  /^(?:chief technolog(?:y|ical)\s+officer|cto)$/,
  /\bproduct manager\b/,
  /\bproduct lead\b/,
  /\bhead of product$/,
  /\bvp(?:\s+of)?\s+product$/,
  /\bvice president(?:\s+of)?\s+product$/,
  /^(?:chief product officer|cpo)$/,
  /\blead engineer\b/,
  /^engineering lead\b/,
  /^engineering manager\b/,
  /\bhead of engineering\b/,
  /\bvp(?:\s+of)?\s+engineering\b/,
  /\bvice president(?:\s+of)?\s+engineering\b/,
  /\bdirector of engineering\b/,
  /^engineering director\b/,
  /^tech(?:nical)?\s+lead\b/,
];

function normalizeTierText(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Which tier an agent gets: `high` for leadership — `ceo`/`chief_of_staff`
 * by role enum, `pm`/`cto` when a present title confirms leadership
 * (Product Manager, Head of Product, VP Product, CPO; CTO, Lead Engineer,
 * Engineering Lead, Head of Engineering, VP Engineering), and any role
 * whose title is leadership wording. Everything else is `low` — the safe
 * fallback is always the cheaper ops tier.
 */
export function modelTierForRole(
  role: string | null | undefined,
  title?: string | null,
): HermesModelTierId {
  const normalizedRole = normalizeTierText(role).replace(/\s+/g, "_");
  const normalizedTitle = normalizeTierText(title);
  const leadershipTitle =
    normalizedTitle.length > 0
    && HIGH_TIER_TITLE_PATTERNS.some((pattern) => pattern.test(normalizedTitle));
  if (HIGH_TIER_ROLES.has(normalizedRole)) return "high";
  if (LEADERSHIP_TITLE_ROLES.has(normalizedRole)) {
    return normalizedTitle ? (leadershipTitle ? "high" : "low") : "high";
  }
  return leadershipTitle ? "high" : "low";
}

// ---------------------------------------------------------------------------
// Applying the default
// ---------------------------------------------------------------------------

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Stamp the tier's model/provider onto a hermes_local adapterConfig that has
 * no explicit model. An explicit `model` a person set always wins and is
 * reported back as `appliedTier: null`. An explicit `provider` that differs
 * from the tier's is a person's choice too — pairing a tier model with
 * someone else's provider would silently re-route billing, so the config is
 * left untouched then as well.
 *
 * This is the PURE half of the tier rule: it applies whenever a caller asks
 * it to. Whether an instance wants the tiers at all — and whether a
 * company's own model key forbids them — is the server-side gate in
 * server/src/services/hermes-model-tiers.ts.
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
  const existingProvider = nonEmptyString(adapterConfig.provider);
  if (existingProvider && existingProvider !== spec.provider) {
    return { adapterConfig, appliedTier: null };
  }
  adapterConfig.model = spec.model;
  if (!existingProvider) {
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
 * "DeepSeek V4.1 Flash · ops tier". A model with no tier and no plain-words
 * name is shown as its raw `provider/model` label (e.g.
 * "zai/glm-5.3-flash") so it is never dressed up as something it is not.
 * Returns null when there is nothing useful to say (no model).
 */
export function describeHermesModel(input: {
  model: string | null | undefined;
  modelTier?: string | null;
  provider?: string | null;
  env?: NodeJS.ProcessEnv;
}): { text: string; rawTitle: string } | null {
  const model = (input.model ?? "").trim();
  if (!model) return null;
  const provider = (input.provider ?? "").trim();
  const raw = provider ? `${provider}/${model}` : model;
  const tier = hermesModelTierLabel(input.modelTier) ?? null;
  const inferredTier = input.modelTier ? null : hermesModelTierForModel(model, input.env);
  const tierText = tier ?? (inferredTier ? hermesModelTierLabel(inferredTier) : null);
  const name = hermesModelDisplayName(model);
  return {
    text: tierText ? `${name ?? model} · ${tierText}` : name ?? raw,
    rawTitle: raw,
  };
}
