// AgentDash: onboarding-driven model adapter setup.
//
// Lets a customer pick their agent "brain" during onboarding (claude / openai /
// gemini / stub) without hand-editing env files. A preset maps to a small set of
// process.env vars that dispatchLLM + the provider clients (anthropic-llm,
// openai-compat-llm, minimax-llm) already read. applyAdapterPreset sets them
// HOT (in the running process — the LLM clients re-read env per call, so no
// restart is needed) AND persists them to the launchd env file so they survive
// a service restart.
//
// This is a single-tenant customer install: the key is process-global, lives in
// a root/local env file, and is NEVER written to the DB. Founding board user
// only (enforced in the route).

import { accessSync, constants, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { logger } from "../middleware/logger.js";
import { badRequest } from "../errors.js";

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export type AdapterPreset = "claude" | "openai" | "gemini" | "stub";

export const ADAPTER_PRESETS: AdapterPreset[] = ["claude", "openai", "gemini", "stub"];

/**
 * Each preset resolves to a set of env assignments. Values are literal except
 * the placeholder "{KEY}", which is replaced with the customer-provided API key.
 * The `stub` preset needs no key — it flips the existing E2E stub machinery on,
 * which returns canned (but shaped-correct) interview + plan responses.
 */
const PRESET_ENV: Record<AdapterPreset, Array<{ key: string; value: string }>> = {
  claude: [{ key: "AGENTDASH_DEFAULT_ADAPTER", value: "claude_api" }, { key: "ANTHROPIC_API_KEY", value: "{KEY}" }],
  openai: [
    { key: "AGENTDASH_DEFAULT_ADAPTER", value: "openai_compat" },
    { key: "OPENAI_COMPAT_API_KEY", value: "{KEY}" },
    { key: "OPENAI_COMPAT_BASE_URL", value: "https://api.openai.com/v1" },
    { key: "OPENAI_COMPAT_MODEL", value: "gpt-4o-mini" },
  ],
  gemini: [
    { key: "AGENTDASH_DEFAULT_ADAPTER", value: "openai_compat" },
    { key: "OPENAI_COMPAT_API_KEY", value: "{KEY}" },
    { key: "OPENAI_COMPAT_BASE_URL", value: "https://generativelanguage.googleapis.com/v1beta/openai" },
    { key: "OPENAI_COMPAT_MODEL", value: "gemini-2.0-flash" },
  ],
  stub: [{ key: "PAPERCLIP_E2E_SKIP_LLM", value: "true" }],
};

export interface AdapterPresetOption {
  preset: AdapterPreset;
  label: string;
  requiresKey: boolean;
  /** Default unset — preserved, never overwritten, on apply. */
  description: string;
}

export function adapterPresetOptions(): AdapterPresetOption[] {
  return [
    { preset: "claude", label: "Claude (Anthropic)", requiresKey: true, description: "ANTHROPIC_API_KEY" },
    { preset: "openai", label: "OpenAI", requiresKey: true, description: "OPENAI_COMPAT_API_KEY (api.openai.com)" },
    { preset: "gemini", label: "Gemini (Google)", requiresKey: true, description: "OPENAI_COMPAT_API_KEY (Gemini OpenAI-compat)" },
    { preset: "stub", label: "Stub (no key — placeholder plans)", requiresKey: false, description: "Canned responses; wire a real model later" },
  ];
}

// ---------------------------------------------------------------------------
// Status / probe (cheap, synchronous, never sends the key over the network)
// ---------------------------------------------------------------------------

export interface AdapterStatus {
  /** Resolved adapter name (env-derived), e.g. claude_api, openai_compat, minimax. */
  adapter: string;
  /** True when the configured adapter has what it needs to make a real call. */
  ready: boolean;
  /** Human-facing preset name if one is recognizably configured. */
  preset: AdapterPreset | "custom" | "stub";
  /** Why ready is false, in plain terms. */
  reason: string | null;
}

/**
 * Is `cmd` a runnable program?
 *
 * This used to be `require("node:child_process").execSync("command -v " + cmd)`.
 * The server runs as ESM, where `require` is not defined — so the call threw
 * `ReferenceError` on every invocation, the bare `catch` swallowed it, and the
 * function returned false for everything. Not just for a missing binary: for
 * `sh` too. `readAdapterStatus` therefore reported
 * `ready: false, reason: "hermes binary not found on PATH"` for `hermes_local`
 * and `claude_local` unconditionally.
 *
 * That is worse than a cosmetic bug, because `/health` and onboarding both read
 * it: an on-prem box answered "am I working?" with *no* while it was happily
 * serving replies through that exact binary. Caught on the mkboard instance,
 * which was mid-conversation over Hermes at the time. The existing tests only
 * exercised the stub/openai/gemini presets, so nothing covered the two adapters
 * this actually broke.
 *
 * Resolved without a shell. The old string was interpolated straight into a
 * shell command, so an operator's `AGENTDASH_HERMES_COMMAND` containing a
 * semicolon would have been executed — a real hole in a value that is meant to
 * be nothing but a path.
 */
function hasBinary(cmd: string): boolean {
  const candidate = cmd.trim();
  if (!candidate) return false;

  const isExecutable = (p: string): boolean => {
    try {
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  // A path (absolute or relative) is checked directly — PATH does not apply.
  if (candidate.includes("/")) return isExecutable(candidate);

  // A bare name is resolved against PATH, the same lookup a shell would do.
  const pathEntries = (process.env.PATH ?? "").split(":").filter(Boolean);
  return pathEntries.some((dir) => isExecutable(join(dir, candidate)));
}

export function readAdapterStatus(): AdapterStatus {
  // Stub mode short-circuits everything — it is intentionally "ready".
  if (process.env.PAPERCLIP_E2E_SKIP_LLM === "true") {
    return { adapter: "stub", ready: true, preset: "stub", reason: null };
  }
  const adapter = (process.env.AGENTDASH_DEFAULT_ADAPTER ?? "claude_api").trim() || "claude_api";
  switch (adapter) {
    case "claude_api":
      return process.env.ANTHROPIC_API_KEY
        ? { adapter, ready: true, preset: "claude", reason: null }
        : { adapter, ready: false, preset: "claude", reason: "ANTHROPIC_API_KEY not set" };
    case "openai_compat":
      return process.env.OPENAI_COMPAT_API_KEY
        ? { adapter, ready: true, preset: recognizeOpenAiPreset(), reason: null }
        : { adapter, ready: false, preset: recognizeOpenAiPreset(), reason: "OPENAI_COMPAT_API_KEY not set" };
    case "minimax":
      return process.env.MINIMAX_API_KEY
        ? { adapter, ready: true, preset: "custom", reason: null }
        : { adapter, ready: false, preset: "custom", reason: "MINIMAX_API_KEY not set" };
    case "hermes_local":
      return hasBinary(process.env.AGENTDASH_HERMES_COMMAND || "hermes")
        ? { adapter, ready: true, preset: "custom", reason: null }
        : { adapter, ready: false, preset: "custom", reason: "hermes binary not found on PATH" };
    case "claude_local":
      return hasBinary("claude")
        ? { adapter, ready: true, preset: "custom", reason: null }
        : { adapter, ready: false, preset: "custom", reason: "claude binary not found on PATH" };
    default:
      return { adapter, ready: false, preset: "custom", reason: `adapter '${adapter}' has no readiness check` };
  }
}

function recognizeOpenAiPreset(): AdapterPreset | "custom" {
  const base = (process.env.OPENAI_COMPAT_BASE_URL ?? "").toLowerCase();
  const model = (process.env.OPENAI_COMPAT_MODEL ?? "").toLowerCase();
  if (base.includes("generativelanguage.googleapis.com") || model.startsWith("gemini")) return "gemini";
  if (base.includes("api.openai.com") || model.startsWith("gpt")) return "openai";
  return "custom";
}

// ---------------------------------------------------------------------------
// Apply (hot-set env + persist to the launchd env file)
// ---------------------------------------------------------------------------

export interface ApplyAdapterPresetInput {
  preset: AdapterPreset;
  apiKey?: string;
}

export interface ApplyAdapterPresetResult {
  status: AdapterStatus;
  /** Env vars applied (key only — never echo the secret value back). */
  applied: string[];
  persisted: boolean;
  /** Non-fatal: env was set hot but the env file could not be written. */
  persistError: string | null;
}

function envFilePath(): string {
  // docker/launchd/install.sh writes ~/.config/agentdash/agentdash.env.
  // Allow override for tests / non-launchd layouts.
  return process.env.AGENTDASH_ENV_FILE ?? join(homedir(), ".config", "agentdash", "agentdash.env");
}

/** Merge assignments into a KEY=VALUE env file, replacing existing keys. */
function mergeEnvFile(path: string, assignments: Array<{ key: string; value: string }>): void {
  let lines: string[] = [];
  if (existsSync(path)) {
    lines = readFileSync(path, "utf8").split(/\r?\n/);
  }
  const byKey = new Map(assignments.map((a) => [a.key, a]));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const m = /^([A-Z_][A-Z0-9_]*)\s*=/.exec(line);
    if (m && byKey.has(m[1])) {
      seen.add(m[1]);
      out.push(`${m[1]}=${byKey.get(m[1])!.value}`);
    } else if (m && m[1] === "PAPERCLIP_E2E_SKIP_LLM" && byKey.has("PAPERCLIP_E2E_SKIP_LLM") === false) {
      // Switching OFF stub mode: drop the skip flag so a real adapter runs.
      // (Only when applying a non-stub preset.)
      continue;
    } else {
      out.push(line);
    }
  }
  for (const a of assignments) {
    if (!seen.has(a.key)) out.push(`${a.key}=${a.value}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, out.join("\n"), "utf8");
}

export function applyAdapterPreset(input: ApplyAdapterPresetInput): ApplyAdapterPresetResult {
  const preset = input.preset;
  const template = PRESET_ENV[preset];
  if (!template) {
    throw badRequest(`Unknown adapter preset: ${preset}`);
  }
  const requiresKey = adapterPresetOptions().find((o) => o.preset === preset)!.requiresKey;
  const apiKey = (input.apiKey ?? "").trim();
  if (requiresKey && !apiKey) {
    throw badRequest(`Preset '${preset}' requires an API key`);
  }

  // Resolve the {KEY} placeholder + clear stub mode when moving to a real model.
  const assignments = template.map((a) => ({ key: a.key, value: a.value.replace("{KEY}", apiKey) }));
  // When applying a real preset, ensure E2E stub mode is off in the process.
  if (preset !== "stub") {
    delete process.env.PAPERCLIP_E2E_SKIP_LLM;
  }

  // Hot-set: dispatchLLM and the provider clients read these per call.
  for (const a of assignments) {
    process.env[a.key] = a.value;
  }

  // Persist (best-effort). Failure here is non-fatal — the running process is
  // already configured; a restart just won't remember it.
  let persisted = false;
  let persistError: string | null = null;
  try {
    mergeEnvFile(envFilePath(), assignments);
    persisted = true;
  } catch (err) {
    persistError = err instanceof Error ? err.message : String(err);
    logger.warn({ err, preset }, "[adapter-presets] could not persist env file; hot-set only");
  }

  return {
    status: readAdapterStatus(),
    applied: assignments.map((a) => a.key),
    persisted,
    persistError,
  };
}
