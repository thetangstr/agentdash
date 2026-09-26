// AgentDash (GH #782): how a GitHub credential reaches `git` without ever
// being written into a repo URL, a git config file or a log.
//
// Two paths, one per process that talks to GitHub:
//
// 1. The server's own clone of a managed project checkout
//    (heartbeat.ts ensureManagedProjectWorkspace). The token is handed to that
//    one `git` process in an environment variable, and a `-c` credential
//    helper (given before the `clone` subcommand, so it is not persisted into
//    the new repo's config) echoes it back to git. The helper text holds the
//    variable NAME, not the value.
//
// 2. The agent's own `git push` / `git fetch` inside the checkout. The
//    checkout's local config gets a credential helper that asks the control
//    plane for a credential with the run's own API key
//    (POST /api/agent-git-credential, routes/github-connection.ts). The helper
//    holds no secret. This path is needed because Hermes scrubs GH_TOKEN and
//    GITHUB_TOKEN from every terminal child, and the Hermes wrapper does not
//    forward the resolved run env anyway (adapters/registry.ts), so an env
//    variable would never reach `git`.
//
// The agent runs with a shell, so it can always obtain the token (for example
// by running `git credential fill`). That is why the connection accepts only
// fine-grained tokens scoped to one repository, and why run output is scrubbed
// of anything token-shaped (redactGitHubTokens).

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const GITHUB_HOST = "github.com";
export const GITHUB_HTTPS_PREFIX = `https://${GITHUB_HOST}`;
/** The git username GitHub expects alongside a token. */
export const GITHUB_TOKEN_USERNAME = "x-access-token";

/** The only variable the clone-time helper reads. Never set process-wide. */
export const CLONE_TOKEN_ENV = "AGENTDASH_GIT_CLONE_TOKEN";

const CREDENTIAL_KEY = `credential.${GITHUB_HTTPS_PREFIX}.helper`;
const USE_HTTP_PATH_KEY = `credential.${GITHUB_HTTPS_PREFIX}.useHttpPath`;

/** Clone-time helper: echoes the token from CLONE_TOKEN_ENV. Holds no secret. */
export const CLONE_CREDENTIAL_HELPER =
  `!f() { test "$1" = get || return 0; echo username=${GITHUB_TOKEN_USERNAME}; echo "password=$${CLONE_TOKEN_ENV}"; }; f`;

/**
 * Agent-time helper, written into the checkout's local config. Asks the
 * control plane with the run's own credentials; prints nothing (so git fails
 * with its normal auth error) when the run has no key or the server refuses.
 */
export const AGENT_CREDENTIAL_HELPER = [
  "!f() {",
  'test "$1" = get || return 0;',
  'u="${PAPERCLIP_API_URL%/}"; u="${u%/api}";',
  'test -n "$u" && test -n "$PAPERCLIP_API_KEY" || return 0;',
  'curl -fsS --max-time 20 -X POST',
  '-H "Authorization: Bearer $PAPERCLIP_API_KEY"',
  '-H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID"',
  '-H "Content-Type: text/plain"',
  '--data-binary @- "$u/api/agent-git-credential" 2>/dev/null || true;',
  "}; f",
].join(" ");

/** `git` arguments (before the subcommand) that make one invocation use the clone-time helper only. */
export function cloneCredentialGitArgs(): string[] {
  return ["-c", "credential.helper=", "-c", `${CREDENTIAL_KEY}=${CLONE_CREDENTIAL_HELPER}`];
}

/** Env additions for that one invocation. */
export function cloneCredentialEnv(token: string): Record<string, string> {
  return { [CLONE_TOKEN_ENV]: token, GIT_TERMINAL_PROMPT: "0" };
}

export type RunGit = (args: string[], cwd: string) => Promise<unknown>;

const defaultRunGit: RunGit = (args, cwd) => execFile("git", args, { cwd, timeout: 15_000 });

/**
 * Point the checkout's local config at the agent-time helper. The first,
 * empty `helper` entry clears helpers inherited from system or global config
 * (a stale ~/.git-credentials, osxkeychain), so only ours answers for
 * github.com. Idempotent. Writes no secret.
 */
export async function configureCheckoutCredentialHelper(cwd: string, runGit: RunGit = defaultRunGit): Promise<void> {
  await runGit(["config", "--local", "--unset-all", CREDENTIAL_KEY], cwd).catch(() => undefined);
  await runGit(["config", "--local", "--add", CREDENTIAL_KEY, ""], cwd);
  await runGit(["config", "--local", "--add", CREDENTIAL_KEY, AGENT_CREDENTIAL_HELPER], cwd);
  await runGit(["config", "--local", USE_HTTP_PATH_KEY, "true"], cwd);
}

// ---------------------------------------------------------------------------
// git credential protocol (https://git-scm.com/docs/git-credential)
// ---------------------------------------------------------------------------

export interface GitCredentialRequest {
  protocol: string | null;
  host: string | null;
  path: string | null;
}

/** Parse `key=value` lines; ignores anything but protocol, host and path. */
export function parseGitCredentialRequest(text: string): GitCredentialRequest {
  const out: GitCredentialRequest = { protocol: null, host: null, path: null };
  for (const line of text.split(/\r?\n/).slice(0, 64)) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "protocol") out.protocol = value.toLowerCase();
    else if (key === "host") out.host = value.toLowerCase();
    else if (key === "path") out.path = value;
  }
  return out;
}

export function formatGitCredentialResponse(token: string): string {
  return `username=${GITHUB_TOKEN_USERNAME}\npassword=${token}\n\n`;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * GitHub token formats: fine-grained PATs (github_pat_), classic PATs and
 * OAuth, user-to-server, server-to-server (App installation) and refresh
 * tokens (ghp_, gho_, ghu_, ghs_, ghr_).
 */
const GITHUB_TOKEN_RE = /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g;
export const REDACTED_GITHUB_TOKEN = "[redacted-github-token]";

export function redactGitHubTokens(text: string): string {
  if (!text || (!text.includes("github_pat_") && !/gh[pousr]_/.test(text))) return text;
  return text.replace(GITHUB_TOKEN_RE, REDACTED_GITHUB_TOKEN);
}

/** Deep copy with every string passed through redactGitHubTokens. */
export function redactGitHubTokensInValue<T>(value: T, depth = 0): T {
  if (depth > 12) return value;
  if (typeof value === "string") return redactGitHubTokens(value) as T;
  if (Array.isArray(value)) return value.map((entry) => redactGitHubTokensInValue(entry, depth + 1)) as T;
  if (value && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactGitHubTokensInValue(entry, depth + 1);
    }
    return out as T;
  }
  return value;
}

/**
 * Redact a stream delivered in chunks. A token (or its `github_pat_` / `ghX_`
 * prefix) cut by a chunk boundary is held back and joined with the next
 * chunk, so neither half is ever emitted in clear. Only a tail that starts a
 * word and could still grow into a token is held; `flush()` releases it (as
 * a redaction marker if it had grown past a prefix).
 */
export function createGitHubTokenStreamRedactor(maxHold = 512) {
  // A word-initial tail that is a prefix of "github_pat_…" or "gh[pousr]_…".
  const HOLD_RE =
    /(?:^|[^A-Za-z0-9_])((?:github_pat_[A-Za-z0-9_]*|g(?:i(?:t(?:h(?:u(?:b(?:_(?:p(?:a(?:t)?)?)?)?)?)?)?)?)?|gh(?:[pousr](?:_[A-Za-z0-9]*)?)?))$/;
  let held = "";
  return {
    push(chunk: string): string {
      const text = held + chunk;
      held = "";
      const match = HOLD_RE.exec(text);
      if (!match) return redactGitHubTokens(text);
      const tail = match[1]!;
      if (tail.length > maxHold) return redactGitHubTokens(text.slice(0, text.length - tail.length)) + REDACTED_GITHUB_TOKEN;
      held = tail;
      return redactGitHubTokens(text.slice(0, text.length - tail.length));
    },
    flush(): string {
      const rest = held;
      held = "";
      if (!rest) return "";
      return /^(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{4,}/.test(rest) ? REDACTED_GITHUB_TOKEN : rest;
    },
  };
}
