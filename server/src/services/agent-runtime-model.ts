// AGE-1: report the model/provider that will serve this agent's next run,
// resolved the same way dispatch resolves it — never the instance-level
// adapter preset from /api/health, which is instance state, not agent state.
//
// The reported model and the serving model could diverge with nothing
// indicating it (MKT-38: the preflight block said MiniMax while the run's own
// system message said glm-5.3-flash). A confident wrong answer about which
// model served a turn is worse than none, because it gets trusted. This module
// is the single resolution used by both agent detail and harness preflight.
//
// Resolution order mirrors what a hermes run actually does:
//   1. Explicit adapterConfig.model — a human chose it in AgentDash.
//   2. The agent's own managed per-agent profile config
//      (~/.hermes/profiles/<profile>/config.yaml), when managed profiles are
//      enabled — `hermes -p <profile>` reads that file, so that is what serves.
//   3. The hermes host default (~/.hermes/config.yaml) via the adapter's own
//      detectModel — the same file the CLI itself falls back to.
//   4. Explicit `unknown`. Never the AgentDash env preset: it answers a
//      different question ("what would dispatchLLM use?") and reporting it
//      here is exactly the staleness this fixes.
//
// Provider goes through the adapter package's resolveProvider chain, which is
// what execute uses, so the reported provider matches the one that will be
// passed to the CLI.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  parseModelFromConfig,
  resolveProvider,
} from "hermes-paperclip-adapter/server";
import { agentProfileName } from "./hermes-profile.js";

/** Injectable seams so this is unit-testable without a real hermes home. */
export interface AgentRuntimeModelDeps {
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => Promise<string>;
  /** Where the adapter's detectModel would read — overridden in tests. */
  detectHostModel?: () => Promise<{ model: string; provider: string } | null>;
}

export type AgentRuntimeModelSource =
  | "agent_adapter_config"
  | "agent_hermes_profile"
  | "hermes_host_default";

export interface AgentRuntimeModel {
  /** The model that will serve the next run, or null when unknowable. */
  model: string | null;
  /**
   * Provider resolved through the adapter's own chain. "auto" is reported
   * verbatim: it means hermes picks at run time, and relabeling that would be
   * the same confident-wrong-answer this exists to prevent.
   */
  provider: string;
  /** Which layer of configuration answered. */
  source: AgentRuntimeModelSource;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Read a hermes config.yaml's model block. Uses the adapter package's own
 * parser so what we report is parsed the same way the CLI parses it.
 */
async function readHermesConfigModel(
  configPath: string,
  readFileImpl: (path: string) => Promise<string>,
): Promise<{ model: string; provider: string } | null> {
  let content: string;
  try {
    content = await readFileImpl(configPath);
  } catch {
    return null;
  }
  const parsed = parseModelFromConfig(content);
  if (!parsed?.model) return null;
  return { model: parsed.model, provider: parsed.provider };
}

export function resolveAgentRuntimeModelSync(
  input: {
    adapterType: string;
    adapterConfig: Record<string, unknown> | null | undefined;
    agentId: string | null | undefined;
    hermesManagedProfilesEnabled: boolean;
  },
  deps: AgentRuntimeModelDeps = {},
): Promise<AgentRuntimeModel> {
  return (async () => {
    const env = deps.env ?? process.env;
    const readFileImpl = deps.readFile ?? ((path: string) => readFile(path, "utf-8"));

    // 1. Explicit model in the agent's AgentDash config.
    const explicitModel = readNonEmptyString(input.adapterConfig?.model);
    if (explicitModel) {
      const explicitProvider = readNonEmptyString(input.adapterConfig?.provider);
      const { provider } = resolveProvider({
        explicitProvider: explicitProvider ?? undefined,
        detectedProvider: undefined,
        detectedModel: undefined,
        model: explicitModel,
      });
      return { model: explicitModel, provider, source: "agent_adapter_config" };
    }

    // 2. The agent's managed per-agent hermes profile — the config that
    //    `hermes -p <profile>` actually loads.
    if (input.hermesManagedProfilesEnabled && input.agentId) {
      const hermesHome = readNonEmptyString(env.HERMES_HOME) ?? join(homedir(), ".hermes");
      const profileConfigPath = resolve(
        hermesHome,
        "profiles",
        agentProfileName(input.agentId),
        "config.yaml",
      );
      const profileModel = await readHermesConfigModel(profileConfigPath, readFileImpl);
      if (profileModel) {
        const { provider } = resolveProvider({
          explicitProvider: undefined,
          detectedProvider: profileModel.provider || undefined,
          detectedModel: profileModel.model,
          model: profileModel.model,
        });
        return { model: profileModel.model, provider, source: "agent_hermes_profile" };
      }
    }

    // 3. The hermes host default — the same file the CLI itself falls back to.
    if (deps.detectHostModel) {
      const hostModel = await deps.detectHostModel();
      if (hostModel?.model) {
        const { provider } = resolveProvider({
          explicitProvider: undefined,
          detectedProvider: hostModel.provider || undefined,
          detectedModel: hostModel.model,
          model: hostModel.model,
        });
        return { model: hostModel.model, provider, source: "hermes_host_default" };
      }
    }

    // 4. Unknown means unknown — never the instance adapter preset.
    return { model: null, provider: "unknown", source: "hermes_host_default" };
  })();
}
