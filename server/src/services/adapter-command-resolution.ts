// AgentDash (security, #735): resolve the default Hermes command to an
// absolute path once, from the server's own PATH at boot.
//
// The default `hermes` command used to be spawned by bare name, so whichever
// `hermes` came first on the child's PATH ran — and the child's PATH could be
// shaped by env merged into the run (project env, before #735 filtered it).
// Resolving it once, from the environment the operator started the server
// with, pins the binary: later env cannot redirect it. When the command
// cannot be found at boot (not installed yet, or a test), the bare name stays
// and the spawn behaves as before.
import fs from "node:fs";
import path from "node:path";
import { logger } from "../middleware/logger.js";

export const DEFAULT_HERMES_COMMAND = "hermes";

let resolvedDefaultHermes: { from: string; to: string } | null = null;

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve `command` the way a shell would, against `searchPath` (defaults to
 * the server's PATH). A command containing a slash is taken as a path.
 * Returns the absolute path, or null when nothing executable is found.
 */
export function resolveCommandOnPath(command: string, searchPath: string | undefined = process.env.PATH): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  if (trimmed.includes("/")) {
    const absolute = path.resolve(trimmed);
    return isExecutableFile(absolute) ? absolute : null;
  }
  for (const dir of (searchPath ?? "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, trimmed);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** The configured default Hermes command (AGENTDASH_HERMES_COMMAND or `hermes`), unresolved. */
export function configuredDefaultHermesCommand(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.AGENTDASH_HERMES_COMMAND;
  return typeof configured === "string" && configured.trim().length > 0 ? configured.trim() : DEFAULT_HERMES_COMMAND;
}

/**
 * Call once at boot. Resolves the default Hermes command against the server's
 * PATH and remembers the absolute path.
 */
export function initializeDefaultAdapterCommands(env: NodeJS.ProcessEnv = process.env): void {
  const from = configuredDefaultHermesCommand(env);
  const to = resolveCommandOnPath(from, env.PATH);
  if (to) {
    resolvedDefaultHermes = { from, to };
    logger.info({ command: from, resolved: to }, "Resolved the default Hermes command to an absolute path");
  } else {
    resolvedDefaultHermes = null;
    logger.warn(
      { command: from },
      "Default Hermes command not found on the server PATH at boot; it will be spawned by name",
    );
  }
}

/**
 * The default Hermes command to spawn: the absolute path resolved at boot when
 * it still matches the configured command, otherwise the configured command.
 */
export function defaultHermesCommand(env: NodeJS.ProcessEnv = process.env): string {
  const configured = configuredDefaultHermesCommand(env);
  if (resolvedDefaultHermes && resolvedDefaultHermes.from === configured) return resolvedDefaultHermes.to;
  return configured;
}

/**
 * Map a configured command to the pinned absolute path when it is the default
 * Hermes command by bare name (`hermes` or the configured default).
 * Anything else is returned unchanged.
 */
export function pinDefaultHermesCommand(command: string, env: NodeJS.ProcessEnv = process.env): string {
  const trimmed = command.trim();
  if (trimmed === DEFAULT_HERMES_COMMAND || trimmed === configuredDefaultHermesCommand(env)) {
    return defaultHermesCommand(env);
  }
  return command;
}

/** Test seam. */
export function resetDefaultAdapterCommandsForTests(): void {
  resolvedDefaultHermes = null;
}
