export interface SessionCompactionPolicy {
  enabled: boolean;
  maxSessionRuns: number;
  maxRawInputTokens: number;
  maxSessionAgeHours: number;
}

export type NativeContextManagement = "confirmed" | "likely" | "unknown" | "none";

export interface AdapterSessionManagement {
  supportsSessionResume: boolean;
  nativeContextManagement: NativeContextManagement;
  defaultSessionCompaction: SessionCompactionPolicy;
}

// AgentDash: Per-adapter context window budgets
// These define how much context each adapter can handle and how to allocate it.
export interface AdapterContextBudget {
  /** Maximum input tokens the adapter's model can accept */
  maxContextTokens: number;
  /** Tokens reserved for model output (not available for prompt) */
  reservedOutputTokens: number;
  /** Trigger platform-level compaction when this % of context is used */
  compactionThresholdPct: number;
  /** Whether the platform should manage prompt truncation (false = adapter handles it) */
  platformManagedTruncation: boolean;
}

export const ADAPTER_CONTEXT_BUDGETS: Record<string, AdapterContextBudget> = {
  claude_local: {
    maxContextTokens: 200_000,
    reservedOutputTokens: 16_000,
    compactionThresholdPct: 0, // Claude CLI manages its own context
    platformManagedTruncation: false,
  },
  codex_local: {
    maxContextTokens: 200_000,
    reservedOutputTokens: 16_000,
    compactionThresholdPct: 0, // Codex CLI manages its own context
    platformManagedTruncation: false,
  },
  cursor: {
    maxContextTokens: 128_000,
    reservedOutputTokens: 8_000,
    compactionThresholdPct: 80,
    platformManagedTruncation: true,
  },
  gemini_local: {
    maxContextTokens: 1_000_000,
    reservedOutputTokens: 32_000,
    compactionThresholdPct: 85,
    platformManagedTruncation: true,
  },
  opencode_local: {
    maxContextTokens: 128_000,
    reservedOutputTokens: 8_000,
    compactionThresholdPct: 80,
    platformManagedTruncation: true,
  },
  pi_local: {
    maxContextTokens: 128_000,
    reservedOutputTokens: 8_000,
    compactionThresholdPct: 80,
    platformManagedTruncation: true,
  },
  openclaw_gateway: {
    maxContextTokens: 128_000,
    reservedOutputTokens: 8_000,
    compactionThresholdPct: 80,
    platformManagedTruncation: true,
  },
  hermes_local: {
    maxContextTokens: 128_000,
    reservedOutputTokens: 8_000,
    compactionThresholdPct: 80,
    platformManagedTruncation: true,
  },
};

// AgentDash: Token budget allocation for prompt sections.
// Priority order determines what gets truncated first when over budget.
// Lower priority = truncated first.
export interface PromptSectionBudget {
  /** Section name matching buildCoordinationPrompt sections */
  section: string;
  /** Priority (1 = highest, truncated last). Identity/Protocol are highest. */
  priority: number;
  /** Maximum % of available prompt budget this section can consume */
  maxBudgetPct: number;
  /** Hard floor: minimum tokens to always include (0 = can be fully dropped) */
  minTokens: number;
}

export const DEFAULT_PROMPT_SECTION_BUDGETS: PromptSectionBudget[] = [
  { section: "identity",     priority: 1, maxBudgetPct: 15, minTokens: 200 },
  { section: "protocol",     priority: 2, maxBudgetPct: 10, minTokens: 150 },
  { section: "task",         priority: 3, maxBudgetPct: 25, minTokens: 100 },
  { section: "organization", priority: 4, maxBudgetPct: 10, minTokens: 50 },
  { section: "skills",       priority: 5, maxBudgetPct: 20, minTokens: 0 },
  { section: "plan",         priority: 6, maxBudgetPct: 15, minTokens: 0 },
  { section: "handoff",      priority: 7, maxBudgetPct: 5,  minTokens: 0 },
];

export function getAdapterContextBudget(adapterType: string | null | undefined): AdapterContextBudget | null {
  if (!adapterType) return null;
  return ADAPTER_CONTEXT_BUDGETS[adapterType] ?? null;
}

/**
 * Calculate the available prompt token budget for an adapter.
 * Returns 0 if the adapter manages its own context.
 */
export function getPromptTokenBudget(adapterType: string | null | undefined): number {
  const budget = getAdapterContextBudget(adapterType);
  if (!budget || !budget.platformManagedTruncation) return 0;
  return budget.maxContextTokens - budget.reservedOutputTokens;
}

export interface ResolvedSessionCompactionPolicy {
  policy: SessionCompactionPolicy;
  adapterSessionManagement: AdapterSessionManagement | null;
  explicitOverride: Partial<SessionCompactionPolicy>;
  source: "adapter_default" | "agent_override" | "legacy_fallback";
}

const DEFAULT_SESSION_COMPACTION_POLICY: SessionCompactionPolicy = {
  enabled: true,
  maxSessionRuns: 200,
  maxRawInputTokens: 2_000_000,
  maxSessionAgeHours: 72,
};

// Adapters with native context management still participate in session resume,
// but Paperclip should not rotate them using threshold-based compaction.
const ADAPTER_MANAGED_SESSION_POLICY: SessionCompactionPolicy = {
  enabled: true,
  maxSessionRuns: 0,
  maxRawInputTokens: 0,
  maxSessionAgeHours: 0,
};

export const LEGACY_SESSIONED_ADAPTER_TYPES = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "opencode_local",
  "pi_local",
]);

export const ADAPTER_SESSION_MANAGEMENT: Record<string, AdapterSessionManagement> = {
  claude_local: {
    supportsSessionResume: true,
    nativeContextManagement: "confirmed",
    defaultSessionCompaction: ADAPTER_MANAGED_SESSION_POLICY,
  },
  codex_local: {
    supportsSessionResume: true,
    nativeContextManagement: "confirmed",
    defaultSessionCompaction: ADAPTER_MANAGED_SESSION_POLICY,
  },
  cursor: {
    supportsSessionResume: true,
    nativeContextManagement: "unknown",
    defaultSessionCompaction: DEFAULT_SESSION_COMPACTION_POLICY,
  },
  gemini_local: {
    supportsSessionResume: true,
    nativeContextManagement: "unknown",
    defaultSessionCompaction: DEFAULT_SESSION_COMPACTION_POLICY,
  },
  opencode_local: {
    supportsSessionResume: true,
    nativeContextManagement: "unknown",
    defaultSessionCompaction: DEFAULT_SESSION_COMPACTION_POLICY,
  },
  pi_local: {
    supportsSessionResume: true,
    nativeContextManagement: "unknown",
    defaultSessionCompaction: DEFAULT_SESSION_COMPACTION_POLICY,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
  }
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }
  return undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : undefined;
}

export function getAdapterSessionManagement(adapterType: string | null | undefined): AdapterSessionManagement | null {
  if (!adapterType) return null;
  return ADAPTER_SESSION_MANAGEMENT[adapterType] ?? null;
}

export function readSessionCompactionOverride(runtimeConfig: unknown): Partial<SessionCompactionPolicy> {
  const runtime = isRecord(runtimeConfig) ? runtimeConfig : {};
  const heartbeat = isRecord(runtime.heartbeat) ? runtime.heartbeat : {};
  const compaction = isRecord(
    heartbeat.sessionCompaction ?? heartbeat.sessionRotation ?? runtime.sessionCompaction,
  )
    ? (heartbeat.sessionCompaction ?? heartbeat.sessionRotation ?? runtime.sessionCompaction) as Record<string, unknown>
    : {};

  const explicit: Partial<SessionCompactionPolicy> = {};
  const enabled = readBoolean(compaction.enabled);
  const maxSessionRuns = readNumber(compaction.maxSessionRuns);
  const maxRawInputTokens = readNumber(compaction.maxRawInputTokens);
  const maxSessionAgeHours = readNumber(compaction.maxSessionAgeHours);

  if (enabled !== undefined) explicit.enabled = enabled;
  if (maxSessionRuns !== undefined) explicit.maxSessionRuns = maxSessionRuns;
  if (maxRawInputTokens !== undefined) explicit.maxRawInputTokens = maxRawInputTokens;
  if (maxSessionAgeHours !== undefined) explicit.maxSessionAgeHours = maxSessionAgeHours;

  return explicit;
}

export function resolveSessionCompactionPolicy(
  adapterType: string | null | undefined,
  runtimeConfig: unknown,
): ResolvedSessionCompactionPolicy {
  const adapterSessionManagement = getAdapterSessionManagement(adapterType);
  const explicitOverride = readSessionCompactionOverride(runtimeConfig);
  const hasExplicitOverride = Object.keys(explicitOverride).length > 0;
  const fallbackEnabled = Boolean(adapterType && LEGACY_SESSIONED_ADAPTER_TYPES.has(adapterType));
  const basePolicy = adapterSessionManagement?.defaultSessionCompaction ?? {
    ...DEFAULT_SESSION_COMPACTION_POLICY,
    enabled: fallbackEnabled,
  };

  return {
    policy: {
      enabled: explicitOverride.enabled ?? basePolicy.enabled,
      maxSessionRuns: explicitOverride.maxSessionRuns ?? basePolicy.maxSessionRuns,
      maxRawInputTokens: explicitOverride.maxRawInputTokens ?? basePolicy.maxRawInputTokens,
      maxSessionAgeHours: explicitOverride.maxSessionAgeHours ?? basePolicy.maxSessionAgeHours,
    },
    adapterSessionManagement,
    explicitOverride,
    source: hasExplicitOverride
      ? "agent_override"
      : adapterSessionManagement
        ? "adapter_default"
        : "legacy_fallback",
  };
}

export function hasSessionCompactionThresholds(policy: Pick<
  SessionCompactionPolicy,
  "maxSessionRuns" | "maxRawInputTokens" | "maxSessionAgeHours"
>) {
  return policy.maxSessionRuns > 0 || policy.maxRawInputTokens > 0 || policy.maxSessionAgeHours > 0;
}
