// AgentDash (MVL 1.0, #725): the Hermes provider key, set during onboarding.
//
// A hosted box runs every agent on Hermes (#721). Per-agent profiles are cloned
// from a managed template profile (AGENTDASH_HERMES_PROFILE_TEMPLATE, default
// `agentdash`), and a bare copy of a profile's `.env` gives 401 (see
// hermes-profile.ts), so the customer's key has to land in the template through
// Hermes' own configuration command, `hermes -p <profile> config set`.
//
// Order of operations, so a wrong key changes nothing:
//   1. validate the input (provider, key shape, model);
//   2. one small model call straight to the provider with that key and model;
//   3. write provider, model and key into the template profile with Hermes'
//      CLI, restoring the template's previous files if any step fails;
//   4. write the same three settings into every existing agent profile, so
//      agents hired before the key was set use it too;
//   5. record the key as a company secret (encrypted, company-scoped) and a
//      key-free marker next to the template.
//
// Where things live: Hermes keeps the key in the template's and each agent
// profile's `.env` under HERMES_PROFILES_DIR, which the image puts on the
// Railway Volume (/paperclip/.hermes/profiles), so it survives a redeploy
// without re-entry. The company secret is the encrypted system of record.
//
// The key is never logged, returned, or put in an activity entry. It does
// appear on the `hermes config set` command line for the length of that call,
// inside the box's own container; every error message built from a Hermes or
// provider failure is scrubbed of it.

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { badRequest, HttpError } from "../errors.js";
import { agentProfileName } from "./hermes-profile.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

export const HERMES_PROVIDERS = ["zai", "openrouter", "anthropic", "openai"] as const;
export type HermesProviderId = (typeof HERMES_PROVIDERS)[number];

export interface HermesProviderSpec {
  id: HermesProviderId;
  label: string;
  /** Hermes' provider id (`model.provider` in config.yaml). */
  hermesProvider: string;
  /** The `.env` variable Hermes reads the key from, in its registry's priority order. */
  envVar: string;
  defaultModel: string;
  /** Shown next to the key field. */
  keyHint: string;
}

/**
 * The four API-key providers 1.0 supports (#493 keeps OAuth logins and
 * MiniMax out). Provider ids and env vars are Hermes' own
 * (hermes_cli/auth.py PROVIDER_REGISTRY in the pinned release); default models
 * come from its static catalog. glm-5.3-flash on Z.AI is the one proven on the
 * runner.
 */
export const HERMES_PROVIDER_SPECS: Record<HermesProviderId, HermesProviderSpec> = {
  zai: {
    id: "zai",
    label: "Z.AI (GLM)",
    hermesProvider: "zai",
    envVar: "GLM_API_KEY",
    defaultModel: "glm-5.3-flash",
    keyHint: "API key from z.ai",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    hermesProvider: "openrouter",
    envVar: "OPENROUTER_API_KEY",
    defaultModel: "z-ai/glm-5.2",
    keyHint: "sk-or-…",
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    hermesProvider: "anthropic",
    envVar: "ANTHROPIC_API_KEY",
    defaultModel: "claude-sonnet-5",
    keyHint: "sk-ant-… from console.anthropic.com",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    hermesProvider: "openai-api",
    envVar: "OPENAI_API_KEY",
    defaultModel: "gpt-5.4-mini",
    keyHint: "sk-… from platform.openai.com",
  },
};

export function hermesProviderOptions() {
  return HERMES_PROVIDERS.map((id) => {
    const { label, defaultModel, keyHint } = HERMES_PROVIDER_SPECS[id];
    return { provider: id, label, defaultModel, keyHint };
  });
}

/** Company secret name holding the key (one per company). */
export const HERMES_PROVIDER_SECRET_NAME = "hermes-provider-api-key";
/** Key-free record of what was configured, next to the template profile. */
export const HERMES_PROVIDER_MARKER = "agentdash-provider.json";

// Keys go into a dotenv file through Hermes; anything outside this set could
// break the file or smuggle a second variable. Same charset as #714's env-file rule.
const SAFE_KEY = /^[A-Za-z0-9._+/=:@-]+$/;
const SAFE_MODEL = /^[A-Za-z0-9._:/@+-]{1,128}$/;
const MAX_KEY_LENGTH = 1024;

// ---------------------------------------------------------------------------
// Errors (never carry the key)
// ---------------------------------------------------------------------------

export type HermesProviderErrorCode =
  | "provider_key_rejected"
  | "provider_model_unavailable"
  | "provider_unreachable"
  | "provider_error"
  | "hermes_config_failed";

export class HermesProviderSetupError extends HttpError {
  declare code: HermesProviderErrorCode;
  constructor(status: number, code: HermesProviderErrorCode, message: string) {
    super(status, message, { code }, code);
    this.name = "HermesProviderSetupError";
  }
}

/** Replace every occurrence of the key (and anything key-shaped) in text. */
export function redactKey(text: string, apiKey: string): string {
  let out = text;
  if (apiKey) out = out.split(apiKey).join("[redacted]");
  return out.replace(/\b(sk-[A-Za-z0-9_-]{6,}|[A-Za-z0-9]{24,}\.[A-Za-z0-9]{8,})/g, "[redacted]");
}

// ---------------------------------------------------------------------------
// Deps (injectable so tests never touch a real Hermes or provider)
// ---------------------------------------------------------------------------

export interface HermesProviderSecretStore {
  /** Create or rotate the company's secret; returns nothing about the value. */
  put(companyId: string, name: string, value: string, description: string, actorUserId: string | null): Promise<void>;
}

export interface HermesProviderSetupDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** Run a hermes subcommand (argv after the binary). */
  runHermes?: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
  profilesDir?: string;
  secrets?: HermesProviderSecretStore;
  now?: () => Date;
}

function resolveDeps(deps: HermesProviderSetupDeps) {
  const env = deps.env ?? process.env;
  const hermesBin = (env.AGENTDASH_HERMES_COMMAND ?? "").trim() || "hermes";
  const root = (env.AGENTDASH_HERMES_ROOT ?? "").trim() || join(homedir(), ".hermes");
  return {
    env,
    fetch: deps.fetch ?? fetch,
    runHermes:
      deps.runHermes
      ?? ((args: string[]) => execFileAsync(hermesBin, args, { timeout: 60_000, maxBuffer: 1024 * 1024 })),
    profilesDir: deps.profilesDir ?? ((env.HERMES_PROFILES_DIR ?? "").trim() || join(root, "profiles")),
    template: (env.AGENTDASH_HERMES_PROFILE_TEMPLATE ?? "").trim() || "agentdash",
    now: deps.now ?? (() => new Date()),
    secrets: deps.secrets,
  };
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface HermesProviderInput {
  provider: HermesProviderId;
  apiKey: string;
  model: string;
}

export function parseHermesProviderInput(body: unknown): HermesProviderInput {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const provider = record.provider;
  if (typeof provider !== "string" || !(HERMES_PROVIDERS as readonly string[]).includes(provider)) {
    throw badRequest(`provider must be one of: ${HERMES_PROVIDERS.join(", ")}`);
  }
  if (typeof record.apiKey !== "string" || record.apiKey.trim().length === 0) {
    throw badRequest("apiKey required");
  }
  const apiKey = record.apiKey.trim();
  if (apiKey.length > MAX_KEY_LENGTH) throw badRequest("API key is too long");
  if (!SAFE_KEY.test(apiKey)) {
    throw badRequest("API key contains characters that are not allowed (letters, digits and . _ + / = : @ - only).");
  }
  const spec = HERMES_PROVIDER_SPECS[provider as HermesProviderId];
  let model = spec.defaultModel;
  if (record.model !== undefined && record.model !== null && record.model !== "") {
    if (typeof record.model !== "string" || !SAFE_MODEL.test(record.model.trim())) {
      throw badRequest("model must be a model id (letters, digits and . _ : / @ + - only)");
    }
    model = record.model.trim();
  }
  return { provider: provider as HermesProviderId, apiKey, model };
}

// ---------------------------------------------------------------------------
// 2. One small model call
// ---------------------------------------------------------------------------

interface ProbeRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export function buildProviderProbe(input: HermesProviderInput): ProbeRequest {
  const messages = [{ role: "user", content: "Reply with OK." }];
  switch (input.provider) {
    case "zai":
      return {
        url: "https://api.z.ai/api/paas/v4/chat/completions",
        headers: { authorization: `Bearer ${input.apiKey}` },
        body: { model: input.model, messages, max_tokens: 8 },
      };
    case "openrouter":
      return {
        url: "https://openrouter.ai/api/v1/chat/completions",
        headers: { authorization: `Bearer ${input.apiKey}` },
        body: { model: input.model, messages, max_tokens: 8 },
      };
    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/messages",
        headers: { "x-api-key": input.apiKey, "anthropic-version": "2023-06-01" },
        body: { model: input.model, messages, max_tokens: 8 },
      };
    case "openai":
      return {
        url: "https://api.openai.com/v1/chat/completions",
        headers: { authorization: `Bearer ${input.apiKey}` },
        // gpt-5 family models reject max_tokens.
        body: { model: input.model, messages, max_completion_tokens: 16 },
      };
  }
}

/**
 * Prove the key and model work before anything is written. The provider's
 * response body is never echoed (some providers quote part of the key back).
 */
export async function verifyProviderKey(
  input: HermesProviderInput,
  deps: HermesProviderSetupDeps = {},
): Promise<void> {
  const r = resolveDeps(deps);
  const probe = buildProviderProbe(input);
  const label = HERMES_PROVIDER_SPECS[input.provider].label;
  let response: Response;
  try {
    response = await r.fetch(probe.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...probe.headers },
      body: JSON.stringify(probe.body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new HermesProviderSetupError(
      502,
      "provider_unreachable",
      `Could not reach ${label} to check the key. Check the box's network and try again.`,
    );
  }
  if (response.ok) return;
  const status = response.status;
  // Drain without reading into anything that could be logged.
  await response.arrayBuffer().catch(() => undefined);
  if (status === 401 || status === 403) {
    throw new HermesProviderSetupError(
      422,
      "provider_key_rejected",
      `${label} rejected this API key (HTTP ${status}). Check the key and try again.`,
    );
  }
  if (status === 400 || status === 404) {
    throw new HermesProviderSetupError(
      422,
      "provider_model_unavailable",
      `${label} did not accept the model "${input.model}" with this key (HTTP ${status}). Check the model id, or leave it blank for the default.`,
    );
  }
  throw new HermesProviderSetupError(
    502,
    "provider_error",
    `${label} returned HTTP ${status} while checking the key. Try again in a minute.`,
  );
}

// ---------------------------------------------------------------------------
// 3–4. Hermes profiles
// ---------------------------------------------------------------------------

const TEMPLATE_FILES = [".env", "config.yaml", "auth.json"] as const;

function configArgs(profile: string, input: HermesProviderInput): string[][] {
  const spec = HERMES_PROVIDER_SPECS[input.provider];
  return [
    ["-p", profile, "config", "set", spec.envVar, input.apiKey],
    ["-p", profile, "config", "set", "model.provider", spec.hermesProvider],
    ["-p", profile, "config", "set", "model.default", input.model],
  ];
}

async function runRedacted(
  run: (args: string[]) => Promise<unknown>,
  args: string[],
  apiKey: string,
): Promise<void> {
  try {
    await run(args);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // The failing argv contains the key; the message is rebuilt without it.
    throw new Error(redactKey(detail, apiKey).replace(/\s+/g, " ").slice(0, 300));
  }
}

/** Agent profiles AgentDash provisioned (`agentdash-<id>`), never the template itself. */
async function listAgentProfiles(profilesDir: string, template: string): Promise<string[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(profilesDir);
  } catch {
    return [];
  }
  const prefix = agentProfileName("").replace(/-$/, "") + "-";
  return entries.filter((name) => name.startsWith(prefix) && name !== template && name.length > prefix.length).sort();
}

export interface HermesProviderStatus {
  configured: boolean;
  provider: HermesProviderId | null;
  model: string | null;
  configuredAt: string | null;
}

export async function readHermesProviderStatus(deps: HermesProviderSetupDeps = {}): Promise<HermesProviderStatus> {
  const r = resolveDeps(deps);
  try {
    const raw = JSON.parse(await readFile(join(r.profilesDir, r.template, HERMES_PROVIDER_MARKER), "utf8"));
    const provider = (HERMES_PROVIDERS as readonly string[]).includes(raw?.provider) ? raw.provider : null;
    return {
      configured: provider !== null,
      provider,
      model: typeof raw?.model === "string" ? raw.model : null,
      configuredAt: typeof raw?.configuredAt === "string" ? raw.configuredAt : null,
    };
  } catch {
    return { configured: false, provider: null, model: null, configuredAt: null };
  }
}

/** Synchronous twin of readHermesProviderStatus().configured, for readAdapterStatus(). */
export function hermesProviderConfiguredSync(env: NodeJS.ProcessEnv = process.env): boolean {
  const r = resolveDeps({ env });
  try {
    const raw = JSON.parse(readFileSync(join(r.profilesDir, r.template, HERMES_PROVIDER_MARKER), "utf8"));
    return (HERMES_PROVIDERS as readonly string[]).includes(raw?.provider);
  } catch {
    return false;
  }
}

export interface ConfigureHermesProviderResult {
  provider: HermesProviderId;
  model: string;
  template: string;
  /** Agent profiles now on the new provider/key. */
  profilesUpdated: number;
  /** Agent profiles that could not be updated (names only). */
  profilesFailed: string[];
}

/**
 * Validate, verify, and write the provider into Hermes. Throws
 * HermesProviderSetupError (HTTP-shaped, key-free) on any failure; a failure
 * before or during the template write leaves the template as it was.
 */
export async function configureHermesProvider(
  companyId: string,
  input: HermesProviderInput,
  actorUserId: string | null,
  deps: HermesProviderSetupDeps = {},
): Promise<ConfigureHermesProviderResult> {
  const r = resolveDeps(deps);

  await verifyProviderKey(input, deps);

  // Template: snapshot, create if missing, configure, restore on failure.
  const templateDir = join(r.profilesDir, r.template);
  const templateExisted = existsSync(templateDir);
  const backupDir = join(r.profilesDir, `.${r.template}.agentdash-backup`);
  const backedUp: string[] = [];
  try {
    if (templateExisted) {
      await rm(backupDir, { recursive: true, force: true });
      await mkdir(backupDir, { recursive: true, mode: 0o700 });
      for (const file of TEMPLATE_FILES) {
        if (existsSync(join(templateDir, file))) {
          await copyFile(join(templateDir, file), join(backupDir, file));
          backedUp.push(file);
        }
      }
    } else {
      await runRedacted(
        r.runHermes,
        ["profile", "create", r.template, "--no-alias", "--description", "AgentDash managed template"],
        input.apiKey,
      );
    }
    for (const args of configArgs(r.template, input)) {
      await runRedacted(r.runHermes, args, input.apiKey);
    }
  } catch (error) {
    if (templateExisted) {
      for (const file of TEMPLATE_FILES) {
        if (backedUp.includes(file)) {
          await copyFile(join(backupDir, file), join(templateDir, file)).catch(() => undefined);
        } else {
          await rm(join(templateDir, file), { force: true }).catch(() => undefined);
        }
      }
    } else {
      await r.runHermes(["profile", "delete", r.template, "-y"]).catch(() => undefined);
      await rm(templateDir, { recursive: true, force: true }).catch(() => undefined);
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new HermesProviderSetupError(
      500,
      "hermes_config_failed",
      `The key works, but Hermes could not save the provider settings: ${redactKey(reason, input.apiKey)}. Nothing was changed.`,
    );
  } finally {
    await rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
  }

  // Agent profiles cloned before the key was set.
  let profilesUpdated = 0;
  const profilesFailed: string[] = [];
  for (const profile of await listAgentProfiles(r.profilesDir, r.template)) {
    try {
      for (const args of configArgs(profile, input)) {
        await runRedacted(r.runHermes, args, input.apiKey);
      }
      profilesUpdated += 1;
    } catch {
      profilesFailed.push(profile);
    }
  }

  if (r.secrets) {
    await r.secrets.put(
      companyId,
      HERMES_PROVIDER_SECRET_NAME,
      input.apiKey,
      `Hermes provider key (${HERMES_PROVIDER_SPECS[input.provider].label})`,
      actorUserId,
    );
  }

  await writeFile(
    join(templateDir, HERMES_PROVIDER_MARKER),
    JSON.stringify({ provider: input.provider, model: input.model, configuredAt: r.now().toISOString() }, null, 2) + "\n",
    { mode: 0o600 },
  );

  return { provider: input.provider, model: input.model, template: r.template, profilesUpdated, profilesFailed };
}
