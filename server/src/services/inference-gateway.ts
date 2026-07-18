// AgentDash: Managed Inference Gateway (MVP)
//
// Single point of model access so agents never carry provider tokens and the
// platform can meter usage. All model calls (the forthcoming `agentdash_native`
// adapter today; optionally external CLIs like Hermes later) resolve their
// endpoint + credentials + model here instead of from per-agent / per-customer
// provider config. This removes the #1 source of run failures observed on the
// mini (expired/missing provider tokens) and retires the cc-switch routing hack.
//
// Shape (MVP): an OpenAI/Anthropic-compatible base URL + an AgentDash-held key
// (cloud) or a BYO key (on-prem), plus a model routing/price table. The MVP can
// point straight at OpenRouter/Fireworks (both OpenAI-compatible, multi-provider)
// via env; a self-hosted proxy (per-company budgets, key isolation, provider
// fallback) is a later hardening step.
//
// Design: doc/plans/2026-06-24-gateway-and-native-adapter-design.md (Part A).

import type { AdapterModel, UsageSummary } from "@paperclipai/adapter-utils";

export type GatewayProtocol = "openai" | "anthropic";

/** One routable model: canonical id (used in agent.adapterConfig.model) -> provider id + price. */
export interface GatewayModelEntry {
  /** canonical id agents/UIs reference */
  id: string;
  label: string;
  /** id sent to the gateway/provider (e.g. an OpenRouter "vendor/model" slug) */
  providerModel: string;
  /** provider slug for reporting/billing */
  provider: string;
  /** USD per 1,000,000 tokens */
  inputPer1M: number;
  outputPer1M: number;
  /** USD per 1,000,000 cached-input tokens; defaults to inputPer1M when unset */
  cachedInputPer1M?: number;
}

/** Everything a caller needs to make a model call through the gateway. */
export interface GatewayModelAccess {
  baseUrl: string;
  apiKey: string;
  /** provider model id to send on the wire */
  model: string;
  /** the canonical id that was resolved (for usage/cost attribution) */
  canonicalModel: string;
  provider: string;
  protocol: GatewayProtocol;
}

/** Optional per-call credential override (e.g. on-prem BYO key from the secrets service). */
export interface GatewayCredentialOverride {
  baseUrl?: string;
  apiKey?: string;
  protocol?: GatewayProtocol;
}

export class GatewayConfigError extends Error {
  readonly code = "gateway_not_configured";
  constructor(message: string) {
    super(message);
    this.name = "GatewayConfigError";
  }
}

// ---------------------------------------------------------------------------
// Model routing / price table
//
// Prices are USD per 1M tokens (list prices as of authoring; keep current with
// the gateway provider). `providerModel` uses the OpenRouter "vendor/model"
// convention so the MVP gateway can be an OpenRouter account with no proxy.
// Add models here; nothing else needs to change.
// ---------------------------------------------------------------------------
export const GATEWAY_MODELS: readonly GatewayModelEntry[] = [
  {
    id: "claude-sonnet",
    label: "Claude Sonnet (via gateway)",
    providerModel: "anthropic/claude-sonnet-4",
    provider: "anthropic",
    inputPer1M: 3,
    outputPer1M: 15,
    cachedInputPer1M: 0.3,
  },
  {
    id: "claude-haiku",
    label: "Claude Haiku (via gateway)",
    providerModel: "anthropic/claude-haiku-4.5",
    provider: "anthropic",
    inputPer1M: 1,
    outputPer1M: 5,
    cachedInputPer1M: 0.1,
  },
  {
    id: "gpt-4o-mini",
    label: "GPT-4o mini (via gateway)",
    providerModel: "openai/gpt-4o-mini",
    provider: "openai",
    inputPer1M: 0.15,
    outputPer1M: 0.6,
    cachedInputPer1M: 0.075,
  },
  {
    id: "minimax-m2",
    label: "MiniMax M2 (via gateway)",
    providerModel: "minimax/minimax-m2",
    provider: "minimax",
    inputPer1M: 0.3,
    outputPer1M: 1.2,
  },
] as const;

/** First entry is the default when no model is requested or the request is unknown. */
export const DEFAULT_GATEWAY_MODEL_ID = GATEWAY_MODELS[0]!.id;

export function findGatewayModel(modelId: string | null | undefined): GatewayModelEntry | undefined {
  if (!modelId) return undefined;
  return GATEWAY_MODELS.find((m) => m.id === modelId || m.providerModel === modelId);
}

/** Models surfaced to the UI / adapter `models` field. */
export function listGatewayModels(): AdapterModel[] {
  return GATEWAY_MODELS.map((m) => ({ id: m.id, label: m.label }));
}

// ---------------------------------------------------------------------------
// Configuration (env-driven for the MVP; thread into Config + secrets later)
// ---------------------------------------------------------------------------
interface GatewayEnv {
  baseUrl: string | undefined;
  apiKey: string | undefined;
  protocol: GatewayProtocol;
}

function readGatewayEnv(env: NodeJS.ProcessEnv = process.env): GatewayEnv {
  const protocolRaw = env.AGENTDASH_GATEWAY_PROTOCOL?.trim().toLowerCase();
  const protocol: GatewayProtocol = protocolRaw === "anthropic" ? "anthropic" : "openai";
  return {
    baseUrl: env.AGENTDASH_GATEWAY_BASE_URL?.trim() || undefined,
    apiKey: env.AGENTDASH_GATEWAY_API_KEY?.trim() || undefined,
    protocol,
  };
}

/** True when a platform gateway key + base URL are configured (cloud default). */
export function isGatewayConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const g = readGatewayEnv(env);
  return Boolean(g.baseUrl && g.apiKey);
}

export interface ResolveGatewayAccessInput {
  companyId: string;
  /** from agent.adapterConfig.model; falls back to the default model */
  requestedModel?: string | null;
  /** on-prem / BYO override; takes precedence over platform env */
  override?: GatewayCredentialOverride;
  /** injectable for tests */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the endpoint + credentials + model for a run. Cloud uses the platform
 * key from env; on-prem passes a BYO override (later sourced from the secrets
 * service, same path adapters already use). Throws GatewayConfigError when no
 * usable credential is available so callers/testEnvironment can report it.
 */
export function resolveGatewayAccess(input: ResolveGatewayAccessInput): GatewayModelAccess {
  const env = readGatewayEnv(input.env);
  const baseUrl = input.override?.baseUrl?.trim() || env.baseUrl;
  const apiKey = input.override?.apiKey?.trim() || env.apiKey;
  const protocol = input.override?.protocol ?? env.protocol;

  if (!baseUrl) {
    throw new GatewayConfigError(
      "Inference gateway base URL is not configured (set AGENTDASH_GATEWAY_BASE_URL or pass an override).",
    );
  }
  if (!apiKey) {
    throw new GatewayConfigError(
      "Inference gateway API key is not configured (set AGENTDASH_GATEWAY_API_KEY or pass a BYO override).",
    );
  }

  const entry = findGatewayModel(input.requestedModel) ?? findGatewayModel(DEFAULT_GATEWAY_MODEL_ID)!;
  return {
    baseUrl,
    apiKey,
    model: entry.providerModel,
    canonicalModel: entry.id,
    provider: entry.provider,
    protocol,
  };
}

// ---------------------------------------------------------------------------
// Usage -> cost (pure). Persistence stays in the existing costEvents path
// (costService.createEvent), which the heartbeat already calls from the
// AdapterExecutionResult. The gateway only supplies the price.
// ---------------------------------------------------------------------------

/**
 * Compute USD cost for a completion from the model price table.
 * `cachedInputTokens` are billed at `cachedInputPer1M` when set, otherwise at
 * the input rate. Returns 0 for unknown models (caller may log/skip).
 */
export function computeGatewayCostUsd(modelId: string, usage: UsageSummary): number {
  const entry = findGatewayModel(modelId);
  if (!entry) return 0;
  const input = Math.max(0, usage.inputTokens ?? 0);
  const output = Math.max(0, usage.outputTokens ?? 0);
  const cached = Math.max(0, usage.cachedInputTokens ?? 0);
  const cachedRate = entry.cachedInputPer1M ?? entry.inputPer1M;
  const cost =
    (input / 1_000_000) * entry.inputPer1M +
    (output / 1_000_000) * entry.outputPer1M +
    (cached / 1_000_000) * cachedRate;
  // round to 6 dp (micro-dollar) to avoid fp noise in stored costs
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export interface GatewayUsageResult {
  costUsd: number;
  provider: string;
  canonicalModel: string;
}

/**
 * Summarize a run's gateway usage into the fields adapters return on
 * AdapterExecutionResult (costUsd/provider/model). Pure — no DB.
 */
export function recordGatewayUsage(input: {
  canonicalModel: string;
  usage: UsageSummary;
}): GatewayUsageResult {
  const entry = findGatewayModel(input.canonicalModel);
  return {
    costUsd: computeGatewayCostUsd(input.canonicalModel, input.usage),
    provider: entry?.provider ?? "unknown",
    canonicalModel: entry?.id ?? input.canonicalModel,
  };
}
