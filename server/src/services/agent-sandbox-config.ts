import os from "node:os";
import path from "node:path";
import {
  configureDefaultLocalSandbox,
  type LocalSandboxSpec,
} from "@paperclipai/adapter-utils/server-utils";
import { EGRESS_POLICIES, type EgressPolicy } from "@paperclipai/adapter-utils/seatbelt";

/**
 * Whether agent subprocesses run confined, read once at startup.
 *
 * `AGENTDASH_AGENT_SANDBOX` is one of:
 *   off        (default) — agents run unconfined, as they always have
 *   loopback              — confined; egress denied except loopback
 *   direct                — confined; outbound 443 re-opened, no proxy in front
 *
 * Off by default on purpose. Switching this on changes how every agent on the
 * host runs, and the first thing it will do is surface which runtime paths the
 * agent CLI needs that live outside its workspace. That belongs in a watched
 * trial on one instance, not in a release note.
 *
 * `AGENTDASH_AGENT_SANDBOX_ALLOW` is a colon-separated list of absolute paths
 * re-opened read-write below the home deny — the escape hatch for exactly those
 * runtime paths. Every entry is a hole in the confinement, so it is read back
 * into the startup log rather than applied silently.
 */
export interface AgentSandboxSettings {
  spec: LocalSandboxSpec | null;
  /** Human-readable, for the startup log. */
  summary: string;
}

const ENV_MODE = "AGENTDASH_AGENT_SANDBOX";
const ENV_ALLOW = "AGENTDASH_AGENT_SANDBOX_ALLOW";

export function resolveAgentSandboxSettings(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): AgentSandboxSettings {
  const raw = (env[ENV_MODE] ?? "").trim().toLowerCase();
  if (!raw || raw === "off" || raw === "false" || raw === "0") {
    return { spec: null, summary: "off (agents run unconfined)" };
  }

  if (!(EGRESS_POLICIES as readonly string[]).includes(raw)) {
    // Refuse rather than fall back to off. A typo in this variable would
    // otherwise mean an operator who asked for confinement silently does not
    // have it, which is the failure the whole mechanism exists to prevent.
    throw new Error(
      `${ENV_MODE}="${raw}" is not a valid setting. Use "off", ` +
        `${EGRESS_POLICIES.map((p) => `"${p}"`).join(" or ")}.`,
    );
  }

  if (platform !== "darwin") {
    throw new Error(
      `${ENV_MODE} is set to "${raw}" but this host is "${platform}". ` +
        "Agent confinement relies on macOS Seatbelt and has no fallback; " +
        "unset it or run on macOS rather than proceeding unconfined.",
    );
  }

  const allow = (env[ENV_ALLOW] ?? "")
    .split(":")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const relative = allow.filter((entry) => !path.isAbsolute(entry));
  if (relative.length > 0) {
    throw new Error(
      `${ENV_ALLOW} must contain absolute paths; got ${relative.map((e) => `"${e}"`).join(", ")}.`,
    );
  }

  return {
    spec: {
      homeDir: os.homedir(),
      egress: raw as EgressPolicy,
      readWritePaths: allow,
    },
    summary:
      `on (egress=${raw})` +
      (allow.length > 0 ? `, ${allow.length} extra path(s) re-opened: ${allow.join(", ")}` : ""),
  };
}

/**
 * Apply the setting process-wide. Called once, at startup, before any agent runs.
 */
export function applyAgentSandboxSettings(
  settings: AgentSandboxSettings = resolveAgentSandboxSettings(),
): AgentSandboxSettings {
  configureDefaultLocalSandbox(settings.spec);
  return settings;
}
