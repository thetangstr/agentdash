export interface PaperclipMcpConfig {
  apiUrl: string;
  apiKey: string;
  companyId: string | null;
  agentId: string | null;
  runId: string | null;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Return the first non-empty value among the given env values. */
function firstNonEmpty(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    const resolved = nonEmpty(value);
    if (resolved) return resolved;
  }
  return null;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * The prefix every AgentDash API credential carries.
 *
 * Agent keys are `pcp_…`, and the board, CLI-auth, claim and invite variants are
 * all `pcp_…` too. A bridge endpoint token is unprefixed base64url, because it
 * is not an API credential at all — it reaches the bridge's own routes and
 * nothing else.
 */
const API_CREDENTIAL_PREFIX = "pcp_";

/**
 * Whether this credential can reach the control plane.
 *
 * A steward connecting their own Claude Code passes an endpoint token, which
 * authenticates exactly five tools. Advertising the other seventy-six is not
 * harmless: the session sees a large toolset, picks a plausible one, and gets a
 * 403 that reads like a broken instance rather than the wrong credential.
 *
 * An empty key is treated as control-plane on purpose — a fresh install has no
 * key yet and bootstraps one through the unauthenticated signup tools.
 */
export function isControlPlaneCredential(apiKey: string): boolean {
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) return true;
  return trimmed.startsWith(API_CREDENTIAL_PREFIX);
}

export function normalizeApiUrl(apiUrl: string): string {
  const trimmed = stripTrailingSlash(apiUrl.trim());
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

/**
 * Read the MCP server config from the environment.
 *
 * PAPERCLIP_* variables are canonical; AGENTDASH_* variables are accepted as
 * aliases (first non-empty wins, PAPERCLIP_* checked first).
 */
export function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PaperclipMcpConfig {
  const apiUrl = firstNonEmpty(env.PAPERCLIP_API_URL, env.AGENTDASH_API_URL);
  if (!apiUrl) {
    throw new Error("Missing PAPERCLIP_API_URL (or AGENTDASH_API_URL)");
  }
  // AgentDash (MCP-native signup): the API key is OPTIONAL. On a fresh
  // authenticated-mode install there is no key yet — the unauthenticated
  // tools (setup_status via /health, sign_up) bootstrap one, and
  // client.setApiKey() upgrades the running session in place.
  const apiKey = firstNonEmpty(env.PAPERCLIP_API_KEY, env.AGENTDASH_API_KEY) ?? "";

  return {
    apiUrl: normalizeApiUrl(apiUrl),
    apiKey,
    companyId: firstNonEmpty(env.PAPERCLIP_COMPANY_ID, env.AGENTDASH_COMPANY_ID),
    agentId: nonEmpty(env.PAPERCLIP_AGENT_ID),
    runId: nonEmpty(env.PAPERCLIP_RUN_ID),
  };
}
