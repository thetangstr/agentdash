/**
 * The binary this adapter drives.
 *
 * `codex`, not `codex-acp`, and the distinction is not cosmetic: every
 * invocation this adapter builds starts with `exec --json
 * --skip-git-repo-check` (see `buildCodexExecArgs`). codex-acp speaks the
 * Agent Client Protocol over stdio and answers those arguments with
 * `error: unexpected argument 'exec' found`, so an instance left on the old
 * default could never complete a run.
 *
 * Measured on the MKThink Mini, 2026-08-18: the preflight resolved `codex`
 * and passed, the run resolved `codex-acp` and failed, and the two disagreeing
 * defaults were why a green preflight predicted nothing.
 */
export const DEFAULT_CODEX_COMMAND = "codex";

function trimmed(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Resolve the command for BOTH the probe and the run, so a passing preflight
 * means the thing that will actually be spawned is the thing that was tested.
 *
 * Precedence: per-agent adapter config, then the host override, then the
 * default.
 */
export function resolveCodexCommand(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    trimmed(config.command)
    ?? trimmed(env.AGENTDASH_CODEX_COMMAND)
    ?? DEFAULT_CODEX_COMMAND
  );
}
