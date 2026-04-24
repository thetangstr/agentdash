// AgentDash (AGE-54.1): in-app Codex login support. Mirrors the claude-local
// `runClaudeLogin()` pattern so a non-technical operator can sign in with
// ChatGPT from the agent detail page — no terminal required.
//
// How it works:
//   1. Spawn `codex login` as a child process under the *shared* Codex home
//      (~/.codex by default). We do NOT use the managed per-company home
//      here because ChatGPT OAuth writes tokens once and the managed-home
//      seeder symlinks ~/.codex/auth.json on the next agent run.
//   2. Scrape the OAuth URL out of stdout/stderr. Codex prints a line like
//      "Sign in at https://auth.openai.com/…" that we match.
//   3. Return { loginUrl, stdout, stderr, exitCode } so the UI can render
//      a clickable sign-in link.
//
// The process terminates naturally once the user completes the OAuth flow
// in their browser (Codex CLI detects the token file and exits). If the
// user doesn't complete it within the timeout, the process is killed and
// we return whatever URL/output was captured — they can still click the
// link and finish sign-in manually.

import fs from "node:fs/promises";
import path from "node:path";
import {
  asString,
  parseObject,
  runChildProcess,
} from "@agentdash/adapter-utils/server-utils";
import { resolveSharedCodexHomeDir } from "./codex-home.js";

// Match any URL; prefer those that look like OAuth sign-in URLs.
const URL_RE = /https?:\/\/[^\s<>"')]+/g;
const OAUTH_HINTS = ["auth.openai.com", "openai.com", "chat.openai.com", "oauth"];

export function extractCodexLoginUrl(text: string): string | null {
  const matches = text.match(URL_RE);
  if (!matches || matches.length === 0) return null;
  const clean = (u: string) => u.replace(/[\])}.!,?;:'"]+$/g, "");
  for (const raw of matches) {
    const c = clean(raw);
    if (OAUTH_HINTS.some((hint) => c.toLowerCase().includes(hint))) return c;
  }
  return clean(matches[0] ?? "") || null;
}

export interface CodexLoginResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  loginUrl: string | null;
  stdout: string;
  stderr: string;
  /** Post-login status: set to the authenticated email if we can read it. */
  authenticatedEmail: string | null;
}

export async function runCodexLogin(input: {
  runId: string;
  agent: { id: string; companyId: string; name: string; adapterType: string | null; adapterConfig: unknown };
  config: Record<string, unknown>;
  timeoutSec?: number;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}): Promise<CodexLoginResult> {
  const onLog = input.onLog ?? (async () => {});
  const config = parseObject(input.config);
  const command = asString(config.command, "codex");
  const envConfig = parseObject(config.env);
  const sharedHome = resolveSharedCodexHomeDir(process.env);

  // Run the login under the shared home so OAuth tokens land in the
  // canonical location (~/.codex/auth.json). The managed per-company home
  // will pick them up automatically on the next agent run via the symlink.
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    CODEX_HOME: sharedHome,
  };
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  const timeoutSec = input.timeoutSec ?? 300; // 5 minutes — enough time for OAuth
  const proc = await runChildProcess(input.runId, command, ["login"], {
    cwd: process.cwd(),
    env,
    timeoutSec,
    graceSec: 5,
    onLog,
  });

  const combined = `${proc.stdout}\n${proc.stderr}`;
  const loginUrl = extractCodexLoginUrl(combined);
  const authenticatedEmail = await readCodexAuthenticatedEmail(sharedHome).catch(() => null);

  return {
    exitCode: proc.exitCode,
    signal: proc.signal,
    timedOut: proc.timedOut,
    loginUrl,
    stdout: proc.stdout,
    stderr: proc.stderr,
    authenticatedEmail,
  };
}

export interface CodexAuthStatus {
  authenticated: boolean;
  email: string | null;
  codexHome: string;
}

/**
 * Check whether the shared Codex home has valid auth. Non-blocking; safe
 * to call frequently from the UI to poll sign-in completion.
 */
export async function readCodexAuthStatus(env: NodeJS.ProcessEnv = process.env): Promise<CodexAuthStatus> {
  const codexHome = resolveSharedCodexHomeDir(env);
  const email = await readCodexAuthenticatedEmail(codexHome).catch(() => null);
  return { authenticated: email !== null, email, codexHome };
}

async function readCodexAuthenticatedEmail(codexHome: string): Promise<string | null> {
  const authPath = path.join(codexHome, "auth.json");
  try {
    const raw = await fs.readFile(authPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // codex stores OAuth with `tokens.id_token` (a JWT). Decode the payload
    // to pull out the email claim. If the tokens are missing / expired the
    // JWT decode will fail or the email will be absent — treat that as
    // "not authenticated".
    const tokens = parsed?.tokens as Record<string, unknown> | undefined;
    const idToken = typeof tokens?.id_token === "string" ? tokens.id_token : null;
    if (!idToken) {
      // Fallback: non-OAuth setups (API key) may not have id_token. If
      // OPENAI_API_KEY is present in auth.json or env, treat as authed.
      const key = typeof parsed?.OPENAI_API_KEY === "string" ? parsed.OPENAI_API_KEY : null;
      if (key && key.trim().length > 0) return "(api-key)";
      return null;
    }
    const parts = idToken.split(".");
    if (parts.length < 2) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")) as Record<string, unknown>;
    const email = typeof payload.email === "string" ? payload.email : null;
    return email;
  } catch {
    return null;
  }
}
