/**
 * Warn-level preflight check codes that still block creating or launching an
 * agent. A probe that cannot authenticate or cannot execute at all means the
 * agent fails the moment it runs — that is not an advisory warning.
 *
 * `hermes_no_api_keys` is on the list for the no-provider case: self-hosted
 * Hermes legitimately keeps its LLM keys outside AgentDash's env, but the
 * server downgrades the check to `info` when `hermes status --full` reports a
 * configured provider. A warn that survives means no provider anywhere.
 */
const BLOCKING_PREFLIGHT_WARN_CODES: readonly RegExp[] = [
  /_hello_probe_auth_required$/,
  /_hello_probe_failed$/,
  /^hermes_no_api_keys$/,
];

export function isBlockingPreflightWarnCode(code: string): boolean {
  return BLOCKING_PREFLIGHT_WARN_CODES.some((pattern) => pattern.test(code));
}

/**
 * Structural view of an `AdapterEnvironmentTestResult` — also satisfied by
 * preflight check rows persisted in agent metadata, where fields are plain
 * JSON (`level` and `code` arrive as `unknown`).
 */
export interface PreflightResultLike {
  status: string;
  checks?: ReadonlyArray<unknown> | null;
}

/**
 * The one rule every preflight gate shares: an outright `fail` blocks, and so
 * does a `warn` carrying a check that means the adapter cannot run. Every
 * other warn is advisory. Used by the create/preflight routes, the launch
 * readiness evaluator, and the new-agent gate so the three never disagree.
 */
export function isBlockingPreflightResult(result: PreflightResultLike | null | undefined): boolean {
  if (!result) return false;
  if (result.status === "fail") return true;
  if (result.status !== "warn") return false;
  return (result.checks ?? []).some((check) => {
    if (typeof check !== "object" || check === null) return false;
    const { code, level } = check as { code?: unknown; level?: unknown };
    return level === "warn" && typeof code === "string" && isBlockingPreflightWarnCode(code);
  });
}
