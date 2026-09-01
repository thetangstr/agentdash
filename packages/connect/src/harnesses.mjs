/**
 * Reading and writing the two harnesses' native MCP config.
 *
 * Both Claude Code and Codex ship first-class support for remote MCP over HTTP
 * with a bearer token, so connecting is a config write, not an integration. The
 * shapes below were taken from what each CLI actually writes, not from docs:
 *
 *   ~/.claude.json      { mcpServers: { name: { type, url, headers } } }
 *   ~/.codex/config.toml  [mcp_servers.name] url, bearer_token_env_var
 *
 * We write the files directly rather than shelling out to `claude mcp add` /
 * `codex mcp add` for one reason: those take the token as a command-line
 * argument, which puts it in `ps` output and shell history. A file write does
 * not. The formats are the CLIs' own, so both tools still list, use, and remove
 * these entries normally.
 *
 * Note the asymmetry, which is the harnesses' choice and not ours: Codex
 * references the token through an environment variable and never stores it,
 * while Claude Code stores the literal value in ~/.claude.json. We cannot fix
 * that from here, so we make the file mode tight and tell the truth about it.
 */

/** Codex forbids most punctuation in an env var name; be conservative. */
export function envVarNameFor(serverName) {
  const slug = String(serverName)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `AGENTDASH_KEY_${slug || "DEFAULT"}`;
}

/** Trailing slashes and a trailing `/api` are both things people paste. */
export function normalizeInstanceUrl(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) throw new Error("An instance URL is required");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`Not a usable URL: ${raw}`);
  }
  const path = parsed.pathname.replace(/\/+$/, "").replace(/\/api(\/mcp)?$/, "");
  return `${parsed.origin}${path}`;
}

export function mcpEndpointFor(instanceUrl) {
  return `${normalizeInstanceUrl(instanceUrl)}/api/mcp`;
}

// ---------------------------------------------------------------- Claude Code

export function upsertClaudeConfig(config, serverName, { url, key }) {
  const next = { ...(config ?? {}) };
  next.mcpServers = { ...(next.mcpServers ?? {}) };
  next.mcpServers[serverName] = {
    type: "http",
    url,
    headers: { Authorization: `Bearer ${key}` },
  };
  return next;
}

export function removeClaudeConfig(config, serverName) {
  const next = { ...(config ?? {}) };
  if (!next.mcpServers) return next;
  const servers = { ...next.mcpServers };
  delete servers[serverName];
  next.mcpServers = servers;
  return next;
}

export function readClaudeServer(config, serverName) {
  return config?.mcpServers?.[serverName] ?? null;
}

// ----------------------------------------------------------------- Codex TOML

/**
 * Locate `[mcp_servers.<name>]` and everything belonging to it, which runs to
 * the next table header or end of file. Done textually and deliberately: a
 * full TOML parse would reformat the rest of a file we do not own.
 */
function findCodexBlock(text, serverName) {
  const lines = String(text ?? "").split("\n");
  const header = `[mcp_servers.${serverName}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { lines, start, end };
}

export function upsertCodexToml(text, serverName, { url, envVar }) {
  const block = [
    `[mcp_servers.${serverName}]`,
    `url = "${url}"`,
    `bearer_token_env_var = "${envVar}"`,
  ];
  const found = findCodexBlock(text, serverName);
  if (found) {
    const { lines, start, end } = found;
    return [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n");
  }
  const existing = String(text ?? "").replace(/\s*$/, "");
  return existing.length > 0
    ? `${existing}\n\n${block.join("\n")}\n`
    : `${block.join("\n")}\n`;
}

export function removeCodexToml(text, serverName) {
  const found = findCodexBlock(text, serverName);
  if (!found) return String(text ?? "");
  const { lines, start, end } = found;
  const kept = [...lines.slice(0, start), ...lines.slice(end)];
  // Collapse the blank run the removal leaves behind, so repeated
  // add/remove cycles do not slowly push the file apart.
  return `${kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s*$/, "")}\n`;
}

export function readCodexServer(text, serverName) {
  const found = findCodexBlock(text, serverName);
  if (!found) return null;
  const body = found.lines.slice(found.start + 1, found.end).join("\n");
  const url = body.match(/^\s*url\s*=\s*"([^"]*)"/m)?.[1] ?? null;
  const envVar = body.match(/^\s*bearer_token_env_var\s*=\s*"([^"]*)"/m)?.[1] ?? null;
  return { url, envVar };
}
