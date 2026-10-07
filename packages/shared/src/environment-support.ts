import type { AgentAdapterType, EnvironmentDriver } from "./constants.js";
import type { SandboxEnvironmentProvider } from "./types/environment.js";
import type { JsonSchema } from "./types/plugin.js";

export type EnvironmentSupportStatus = "supported" | "unsupported";

export interface AdapterEnvironmentSupport {
  adapterType: AgentAdapterType;
  drivers: Record<EnvironmentDriver, EnvironmentSupportStatus>;
  sandboxProviders: Record<SandboxEnvironmentProvider, EnvironmentSupportStatus>;
}

export interface EnvironmentProviderCapability {
  status: EnvironmentSupportStatus;
  supportsSavedProbe: boolean;
  supportsUnsavedProbe: boolean;
  supportsRunExecution: boolean;
  supportsReusableLeases: boolean;
  displayName?: string;
  description?: string;
  source?: "builtin" | "plugin";
  pluginKey?: string;
  pluginId?: string;
  configSchema?: JsonSchema;
}

export interface EnvironmentCapabilities {
  adapters: AdapterEnvironmentSupport[];
  drivers: Record<EnvironmentDriver, EnvironmentSupportStatus>;
  sandboxProviders: Record<SandboxEnvironmentProvider, EnvironmentProviderCapability>;
}

const REMOTE_MANAGED_ADAPTERS = new Set<AgentAdapterType>([
  "acpx_local",
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "opencode_local",
  "pi_local",
]);

export function adapterSupportsRemoteManagedEnvironments(adapterType: string): boolean {
  return REMOTE_MANAGED_ADAPTERS.has(adapterType as AgentAdapterType);
}

/**
 * AgentDash: instance-level switches that widen the matrix. Every field is
 * optional and defaults to off, so callers that pass nothing get exactly the
 * pre-existing matrix.
 */
export interface EnvironmentSupportOptions {
  /**
   * AGENTDASH_HERMES_SSH_ENABLED. When on, hermes_local may target SSH
   * environments (never sandboxes). Which ssh targets and companies are
   * permitted is decided server-side by the allowlist, not here.
   */
  hermesSshEnabled?: boolean;
}

export function supportedEnvironmentDriversForAdapter(
  adapterType: string,
  options: EnvironmentSupportOptions = {},
): EnvironmentDriver[] {
  if (adapterSupportsRemoteManagedEnvironments(adapterType)) {
    return ["local", "ssh", "sandbox"];
  }
  // AgentDash: hermes_local over SSH is opt-in per instance.
  if (adapterType === "hermes_local" && options.hermesSshEnabled === true) {
    return ["local", "ssh"];
  }
  return ["local"];
}

export function supportedSandboxProvidersForAdapter(
  adapterType: string,
  additionalProviders: readonly string[] = [],
): SandboxEnvironmentProvider[] {
  return adapterSupportsRemoteManagedEnvironments(adapterType)
    ? Array.from(new Set(additionalProviders)) as SandboxEnvironmentProvider[]
    : [];
}

export function isEnvironmentDriverSupportedForAdapter(
  adapterType: string,
  driver: string,
  options: EnvironmentSupportOptions = {},
): boolean {
  return supportedEnvironmentDriversForAdapter(adapterType, options).includes(driver as EnvironmentDriver);
}

export function isSandboxProviderSupportedForAdapter(
  adapterType: string,
  provider: string | null | undefined,
  additionalProviders: readonly string[] = [],
): boolean {
  if (!provider) return false;
  return supportedSandboxProvidersForAdapter(adapterType, additionalProviders).includes(
    provider as SandboxEnvironmentProvider,
  );
}

export function getAdapterEnvironmentSupport(
  adapterType: AgentAdapterType,
  additionalSandboxProviders: readonly string[] = [],
  options: EnvironmentSupportOptions = {},
): AdapterEnvironmentSupport {
  const supportedDrivers = new Set(supportedEnvironmentDriversForAdapter(adapterType, options));
  const supportedProviders = new Set(supportedSandboxProvidersForAdapter(adapterType, additionalSandboxProviders));
  const sandboxProviders: Record<SandboxEnvironmentProvider, EnvironmentSupportStatus> = {
    fake: "unsupported",
  };
  for (const provider of additionalSandboxProviders) {
    sandboxProviders[provider as SandboxEnvironmentProvider] = supportedProviders.has(provider as SandboxEnvironmentProvider)
      ? "supported"
      : "unsupported";
  }
  return {
    adapterType,
    drivers: {
      local: supportedDrivers.has("local") ? "supported" : "unsupported",
      ssh: supportedDrivers.has("ssh") ? "supported" : "unsupported",
      sandbox: supportedDrivers.has("sandbox") ? "supported" : "unsupported",
      plugin: supportedDrivers.has("plugin") ? "supported" : "unsupported",
    },
    sandboxProviders,
  };
}

export function getEnvironmentCapabilities(
  adapterTypes: readonly AgentAdapterType[],
  options: {
    sandboxProviders?: Record<string, Partial<EnvironmentProviderCapability>>;
  } & EnvironmentSupportOptions = {},
): EnvironmentCapabilities {
  const pluginProviderKeys = Object.keys(options.sandboxProviders ?? {});
  const sandboxProviders: Record<SandboxEnvironmentProvider, EnvironmentProviderCapability> = {
    fake: {
      status: "unsupported",
      supportsSavedProbe: true,
      supportsUnsavedProbe: true,
      supportsRunExecution: false,
      supportsReusableLeases: true,
      displayName: "Fake",
      source: "builtin",
    },
  };
  for (const [provider, capability] of Object.entries(options.sandboxProviders ?? {})) {
    sandboxProviders[provider as SandboxEnvironmentProvider] = {
      status: capability.status ?? "supported",
      supportsSavedProbe: capability.supportsSavedProbe ?? true,
      supportsUnsavedProbe: capability.supportsUnsavedProbe ?? true,
      supportsRunExecution: capability.supportsRunExecution ?? true,
      supportsReusableLeases: capability.supportsReusableLeases ?? true,
      displayName: capability.displayName,
      description: capability.description,
      source: capability.source ?? "plugin",
      pluginKey: capability.pluginKey,
      pluginId: capability.pluginId,
      configSchema: capability.configSchema,
    };
  }
  return {
    adapters: adapterTypes.map((adapterType) => getAdapterEnvironmentSupport(adapterType, pluginProviderKeys, {
      hermesSshEnabled: options.hermesSshEnabled,
    })),
    drivers: {
      local: "supported",
      ssh: "supported",
      sandbox: "supported",
      plugin: "unsupported",
    },
    sandboxProviders,
  };
}
