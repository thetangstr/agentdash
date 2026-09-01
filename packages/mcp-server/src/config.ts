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
