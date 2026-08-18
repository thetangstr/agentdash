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
/**
 * Read-only (and executable) re-openings — the agent's own runtime.
 *
 * Separate from ENV_ALLOW because the distinction is a security boundary, not
 * a convenience: the hermes wrapper execs a Python venv under `~/.hermes/`,
 * and confinement without it fails at exec with code 126 (measured on uat).
 * Putting that tree in the read-WRITE list would let a run rewrite the
 * interpreter every later run uses.
 */
const ENV_READONLY = "AGENTDASH_AGENT_SANDBOX_READONLY";
/**
 * A synthetic `HOME` for agent subprocesses.
 *
 * The one measurement behind this: web search runs through `mcporter`, which
 * probes `$HOME` on startup, and confined it failed with
 * `EPERM open '~/.claude/settings.json'` — the sandbox correctly refusing the
 * operator's personal Claude Code config. The cheap fix is to add `~/.claude`
 * to ENV_ALLOW, and it is the wrong one: it hands every agent on the host the
 * operator's config and whatever sits beside it, to make one tool stop
 * probing. Pointing `HOME` at a directory the operator populated instead
 * turns the probe into a miss and opens nothing.
 *
 * What goes in that directory is the operator's call, and symlinks are the
 * intended tool: `agent-home/.mcporter -> ~/.mcporter` works only because
 * `~/.mcporter` is ALSO listed in ENV_READONLY — SBPL matches the resolved
 * path, so a link to something unlisted stays denied.
 */
const ENV_HOME = "AGENTDASH_AGENT_SANDBOX_HOME";

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

  const splitPaths = (raw: string | undefined, name: string) => {
    const list = (raw ?? "").split(":").map((entry) => entry.trim()).filter(Boolean);
    const relative = list.filter((entry) => !path.isAbsolute(entry));
    if (relative.length > 0) {
      throw new Error(
        `${name} must contain absolute paths; got ${relative.map((e) => `"${e}"`).join(", ")}.`,
      );
    }
    return list;
  };
  const allow = splitPaths(env[ENV_ALLOW], ENV_ALLOW);
  const readOnly = splitPaths(env[ENV_READONLY], ENV_READONLY);

  const syntheticHomeRaw = (env[ENV_HOME] ?? "").trim();
  const syntheticHome = syntheticHomeRaw.length > 0 ? syntheticHomeRaw : undefined;
  if (syntheticHome && !path.isAbsolute(syntheticHome)) {
    throw new Error(`${ENV_HOME} must be an absolute path; got "${syntheticHome}".`);
  }
  // Refuse the setting that would look like confinement and be none. A
  // synthetic home equal to (or above) the real one is re-opened read-write
  // BELOW the home deny, and later rules win in SBPL — the profile would load
  // cleanly and protect nothing. `buildSandboxProfile` refuses this too; the
  // check is here as well so it fails at startup with the variable's name in
  // the message, not on the first agent run with a profile-builder error.
  const realHome = os.homedir();
  // Trailing slashes stripped first, or "/" compares as "//" and the most
  // catastrophic value of all sails through the check.
  const syntheticHomeTrimmed = (syntheticHome ?? "").replace(/\/+$/, "");
  if (
    syntheticHome &&
    (syntheticHomeTrimmed === realHome.replace(/\/+$/, "") ||
      realHome.startsWith(`${syntheticHomeTrimmed}/`))
  ) {
    throw new Error(
      `${ENV_HOME}="${syntheticHome}" is the operator's home directory ("${realHome}") or an ` +
        "ancestor of it. Re-opening that below the home deny would silently disable the " +
        "sandbox. Use a dedicated directory, e.g. ~/.paperclip/agent-home.",
    );
  }

  return {
    spec: {
      homeDir: realHome,
      egress: raw as EgressPolicy,
      readWritePaths: allow,
      readOnlyPaths: readOnly,
      ...(syntheticHome ? { syntheticHomeDir: syntheticHome } : {}),
    },
    summary:
      `on (egress=${raw})` +
      (allow.length > 0 ? `, ${allow.length} rw path(s): ${allow.join(", ")}` : "") +
      (readOnly.length > 0 ? `, ${readOnly.length} read-only path(s): ${readOnly.join(", ")}` : "") +
      (syntheticHome ? `, child HOME: ${syntheticHome}` : ""),
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
