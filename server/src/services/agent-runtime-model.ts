// AgentDash (AGE-1): resolve the model/provider that will serve an agent's
// next run, the same way heartbeat resolves it, and say WHERE the value came
// from. Reporting read a stale AgentDash env preset instead of the harness's
// own selection; a confidently wrong answer about the serving model is worse
// than no answer, so every layer here is explicit or reports `unknown`.
//
// Resolution chain (mirrors heartbeat dispatch):
//   1. explicit `adapterConfig.model` / `adapterConfig.provider`
//      (heartbeat merges model-profile + issue overrides INTO adapterConfig
//      before execute — an explicit model there is what runs)
//   2. the hermes per-agent managed profile's own config
//      (`~/.hermes/profiles/agentdash-<agentId>/config.yaml`) when managed
//      profiles are enabled
//   3. the hermes host default (`~/.hermes/config.yaml`), read through the
//      adapter package's own `detectModel` parser so the reported value is
//      exactly what execute would detect
//   4. explicit `unknown` — never the instance-level adapter preset
//      (`AGENTDASH_DEFAULT_ADAPTER` / `/api/health.adapterPreset` is instance
//      state, not agent state, and must never leak into agent reporting)
//
// Provider resolution reuses the adapter's `resolveProvider` chain so the
// reported provider matches what the spawned command would receive.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  detectModel,
  parseModelFromConfig,
  resolveProvider,
} from "hermes-paperclip-adapter/server";
import { agentProfileName } from "./hermes-profile.js";

const HERMES_LOCAL_ADAPTER_TYPE = "hermes_local";

export interface AgentRuntimeModelInput {
  /** agent row's adapter type, e.g. `hermes_local` */
  adapterType: string;
  /** agent row's adapterConfig (raw, pre-secret-resolution — model/provider are not secrets) */
  adapterConfig: Record<string, unknown> | null | undefined;
  /** agent id; enables the per-agent managed-profile layer */
  agentId?: string | null;
  /** agent row's runtimeConfig; carries per-agent model-profile overrides */
  runtimeConfig?: Record<string, unknown> | null;
}

export type AgentRuntimeModelSource =
  | "adapter_config"
  | "agent_profile"
  | "hermes_host_default"
  | "unknown";

export interface AgentResolvedRuntime {
  /** model that will serve the next run, or null when unknown */
  model: string | null;
  /** provider that will serve the next run, or null when unknown */
  provider: string | null;
  /** which layer answered — a reader can always tell HOW the value was derived */
  source: AgentRuntimeModelSource;
}

/** Injectable seams so tests never touch the real filesystem or adapter. */
export interface RuntimeModelDeps {
  readProfileConfig?: (profileName: string) => Promise<string | null>;
  detectHostModel?: () => Promise<{ model: string; provider: string } | null>;
  env?: NodeJS.ProcessEnv;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Managed hermes profiles are opt-in; the resolver only consults them when on. */
function hermesManagedProfilesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENTDASH_HERMES_MANAGED_PROFILES === "true";
}

function hermesHome(env: NodeJS.ProcessEnv = process.env): string {
  return readNonEmptyString(env.HERMES_HOME) ?? join(homedir(), ".hermes");
}

function defaultReadProfileConfig(profileName: string): Promise<string | null> {
  return readFile(join(hermesHome(), "profiles", profileName, "config.yaml"), "utf-8").catch(
    () => null,
  );
}

function defaultDetectHostModel(): Promise<{ model: string; provider: string } | null> {
  return detectModel().then(
    (detected) => (detected?.model ? { model: detected.model, provider: detected.provider } : null),
    () => null,
  );
}

/**
 * Resolve what will serve this agent's next run. The chain mirrors heartbeat
 * dispatch (explicit adapterConfig → hermes profile → hermes host default →
 * explicit unknown); the instance adapter preset is deliberately never read.
 */
export async function resolveAgentRuntimeModel(
  input: AgentRuntimeModelInput,
  deps: RuntimeModelDeps = {},
): Promise<AgentResolvedRuntime> {
  const cfg = input.adapterConfig ?? {};
  const explicitModel = readNonEmptyString(cfg.model);
  const explicitProvider = readNonEmptyString(cfg.provider);
  if (explicitModel) {
    const resolved = resolveProvider({
      explicitProvider,
      detectedProvider: undefined,
      detectedModel: undefined,
      model: explicitModel,
    });
    return { model: explicitModel, provider: resolved.provider, source: "adapter_config" };
  }

  // Layers 2 and 3 are hermes-specific: a claude/codex/... agent has no hermes
  // profile and no hermes host default, so for them an explicit unknown is the
  // honest answer. Never consult hermes state on their behalf.
  if (input.adapterType !== HERMES_LOCAL_ADAPTER_TYPE) {
    return { model: null, provider: null, source: "unknown" };
  }

  const env = deps.env ?? process.env;
  const profileName = input.agentId ? agentProfileName(input.agentId) : null;
  if (hermesManagedProfilesEnabled(env) && profileName) {
    const content = await (deps.readProfileConfig ?? defaultReadProfileConfig)(profileName);
    const profileModel = content ? parseModelFromConfig(content) : null;
    if (profileModel?.model) {
      return {
        model: profileModel.model,
        provider: resolveProvider({
          explicitProvider,
          detectedProvider: profileModel.provider || undefined,
          detectedModel: profileModel.model,
          model: profileModel.model,
        }).provider,
        source: "agent_profile",
      };
    }
  }

  const hostModel = await (deps.detectHostModel ?? defaultDetectHostModel)();
  if (hostModel) {
    return {
      model: hostModel.model,
      provider: resolveProvider({
        explicitProvider,
        detectedProvider: hostModel.provider || undefined,
        detectedModel: hostModel.model,
        model: hostModel.model,
      }).provider,
      source: "hermes_host_default",
    };
  }

  return { model: null, provider: null, source: "unknown" };
}
