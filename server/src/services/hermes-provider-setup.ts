// AgentDash (MVL 1.0, #725): the Hermes provider key, set during onboarding.
//
// A hosted box runs every agent on Hermes (#721). Per-agent profiles are cloned
// from a managed template profile (AGENTDASH_HERMES_PROFILE_TEMPLATE, default
// `agentdash`), and a bare copy of a profile's `.env` gives 401 (see
// hermes-profile.ts), so the customer's key has to land in the template through
// Hermes' own configuration command, `hermes -p <profile> config set`.
//
// Order of operations, so a wrong key changes nothing and a partial write is
// undone:
//   1. validate the input (provider, key shape, model);
//   2. one small model call straight to the provider with that key and model;
//   3. under a box-wide lock (the template is shared), refuse if the template
//      already belongs to another company;
//   4. write the key to the company's encrypted secret (the source of truth);
//   5. write the key into the template's `.env` and into the `.env` of each of
//      the calling company's own agent profiles, and set provider and model
//      with `hermes config set`; if any profile fails, every profile file and
//      the secret are rolled back and the call fails;
//   6. record a key-free marker (company, provider, model) next to the template.
// `reconcileHermesProviderFromSecret` re-materialises profiles from the secret;
// it runs at boot and whenever an agent profile is provisioned.
//
// The key never appears on a command line: it is written to each profile's
// `.env` directly (temp file, then rename, mode 0600), which is the file
// Hermes reads it from. It is never logged, returned, or put in an activity
// entry, and every error message is scrubbed of it.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
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
  | "provider_owned_by_other_company"
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
  /**
   * Create or rotate the company's secret. Returns an undo that puts the
   * previous value back (or deletes a secret this call created).
   */
  put(
    companyId: string,
    name: string,
    value: string,
    description: string,
    actorUserId: string | null,
  ): Promise<{ restore: () => Promise<void> }>;
  /** The current value, or null when the company has none. */
  get(companyId: string, name: string): Promise<string | null>;
}

export interface HermesProviderSetupDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** Run a hermes subcommand (argv after the binary). Never given a key. */
  runHermes?: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
  profilesDir?: string;
  secrets?: HermesProviderSecretStore;
  /**
   * Serialise setups. The default is an in-process queue; the route wraps it
   * in a Postgres advisory lock so two server processes cannot interleave.
   */
  lock?: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  now?: () => Date;
}

// In-process serialisation, keyed. The route adds a Postgres advisory lock.
const localQueues = new Map<string, Promise<unknown>>();
export function withLocalLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = localQueues.get(key) ?? Promise.resolve();
  const next = prior.catch(() => undefined).then(fn);
  const settled = next.catch(() => undefined);
  localQueues.set(key, settled);
  void settled.then(() => {
    if (localQueues.get(key) === settled) localQueues.delete(key);
  });
  return next;
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
    lock: deps.lock ?? withLocalLock,
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
// Hermes profiles
// ---------------------------------------------------------------------------

/** Files a provider setup may change in a profile; backed up before and restored on failure. */
const PROFILE_FILES = [".env", "config.yaml", "auth.json"] as const;

/**
 * Set one variable in a profile's `.env` without the value ever reaching a
 * command line: read, replace the line, write a temp file with mode 0600 in the
 * same directory, rename it over `.env`, chmod 0600.
 */
export async function writeProfileEnvValue(profileDir: string, envVar: string, value: string): Promise<void> {
  const target = join(profileDir, ".env");
  const prior = existsSync(target) ? await readFile(target, "utf8") : "";
  const kept = prior.split(/\r?\n/).filter((line) => line.length > 0 && !line.startsWith(`${envVar}=`));
  const tmp = join(profileDir, `.env.agentdash-${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, [...kept, `${envVar}=${value}`].join("\n") + "\n", { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  await chmod(target, 0o600);
}

async function runChecked(run: (args: string[]) => Promise<unknown>, args: string[], apiKey: string): Promise<void> {
  try {
    await run(args);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(redactKey(detail, apiKey).replace(/\s+/g, " ").slice(0, 300));
  }
}

/**
 * Put the provider into one profile: the key straight into `.env`, provider
 * and model through Hermes' own `config set` (no secret on the command line),
 * then `auth list` so Hermes refreshes its credential pool from `.env`.
 */
async function applyToProfile(
  r: ReturnType<typeof resolveDeps>,
  profile: string,
  input: HermesProviderInput,
): Promise<void> {
  const spec = HERMES_PROVIDER_SPECS[input.provider];
  await writeProfileEnvValue(join(r.profilesDir, profile), spec.envVar, input.apiKey);
  await runChecked(r.runHermes, ["-p", profile, "config", "set", "model.provider", spec.hermesProvider], input.apiKey);
  await runChecked(r.runHermes, ["-p", profile, "config", "set", "model.default", input.model], input.apiKey);
  await runChecked(r.runHermes, ["-p", profile, "auth", "list"], input.apiKey);
}

/** The calling company's agent profiles that exist on disk. Never other companies'. */
function companyAgentProfiles(r: ReturnType<typeof resolveDeps>, agentIds: readonly string[]): string[] {
  const names = [...new Set(agentIds.map((id) => agentProfileName(id)))];
  return names.filter((name) => name !== r.template && existsSync(join(r.profilesDir, name))).sort();
}

interface ProviderMarker {
  companyId: string | null;
  provider: HermesProviderId | null;
  model: string | null;
  configuredAt: string | null;
}

async function readMarker(r: ReturnType<typeof resolveDeps>): Promise<ProviderMarker | null> {
  try {
    const raw = JSON.parse(await readFile(join(r.profilesDir, r.template, HERMES_PROVIDER_MARKER), "utf8"));
    return {
      companyId: typeof raw?.companyId === "string" ? raw.companyId : null,
      provider: (HERMES_PROVIDERS as readonly string[]).includes(raw?.provider) ? raw.provider : null,
      model: typeof raw?.model === "string" ? raw.model : null,
      configuredAt: typeof raw?.configuredAt === "string" ? raw.configuredAt : null,
    };
  } catch {
    return null;
  }
}

export interface HermesProviderStatus {
  configured: boolean;
  provider: HermesProviderId | null;
  model: string | null;
  configuredAt: string | null;
}

export async function readHermesProviderStatus(deps: HermesProviderSetupDeps = {}): Promise<HermesProviderStatus> {
  const marker = await readMarker(resolveDeps(deps));
  return {
    configured: Boolean(marker?.provider),
    provider: marker?.provider ?? null,
    model: marker?.model ?? null,
    configuredAt: marker?.configuredAt ?? null,
  };
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

/** The company whose key the template holds, or null. */
export async function hermesProviderOwner(deps: HermesProviderSetupDeps = {}): Promise<string | null> {
  return (await readMarker(resolveDeps(deps)))?.companyId ?? null;
}

export interface ConfigureHermesProviderResult {
  provider: HermesProviderId;
  model: string;
  template: string;
  /** The company's agent profiles now on the new provider and key. */
  profilesUpdated: number;
}

/** Lock key: the template is shared by the box, so setups are serialised per template. */
export function hermesProviderLockKey(template = "agentdash"): string {
  return `agentdash:hermes-provider:${template}`;
}

/**
 * Validate, verify, and write the provider into Hermes and the company's
 * secret. All or nothing: any failure after the key is verified restores
 * every profile file this call touched and the secret, then throws a
 * key-free HermesProviderSetupError.
 */
export async function configureHermesProvider(
  companyId: string,
  input: HermesProviderInput,
  actorUserId: string | null,
  opts: { agentIds: readonly string[] },
  deps: HermesProviderSetupDeps = {},
): Promise<ConfigureHermesProviderResult> {
  const r = resolveDeps(deps);
  if (!r.secrets) throw new Error("configureHermesProvider needs a secret store");
  const secrets = r.secrets;

  await verifyProviderKey(input, deps);

  return r.lock(hermesProviderLockKey(r.template), async () => {
    const owner = (await readMarker(r))?.companyId ?? null;
    if (owner && owner !== companyId) {
      throw new HermesProviderSetupError(
        409,
        "provider_owned_by_other_company",
        "This box's Hermes provider belongs to another workspace. A hosted box holds one workspace.",
      );
    }

    await mkdir(r.profilesDir, { recursive: true });
    const backupRoot = await mkdtemp(join(r.profilesDir, ".agentdash-provider-backup-"));
    const templateDir = join(r.profilesDir, r.template);
    const templateExisted = existsSync(templateDir);
    const touched: Array<{ profile: string; backedUp: string[] }> = [];
    let secretRestore: (() => Promise<void>) | null = null;

    const backup = async (profile: string) => {
      const dir = join(backupRoot, profile);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const backedUp: string[] = [];
      for (const file of PROFILE_FILES) {
        const source = join(r.profilesDir, profile, file);
        if (existsSync(source)) {
          await copyFile(source, join(dir, file));
          backedUp.push(file);
        }
      }
      touched.push({ profile, backedUp });
    };

    try {
      // 4. The secret first: it is the source of truth.
      const put = await secrets.put(
        companyId,
        HERMES_PROVIDER_SECRET_NAME,
        input.apiKey,
        `Hermes provider key (${HERMES_PROVIDER_SPECS[input.provider].label})`,
        actorUserId,
      );
      secretRestore = put.restore;

      // 5. Template, then the company's own agent profiles.
      if (!templateExisted) {
        await runChecked(
          r.runHermes,
          ["profile", "create", r.template, "--no-alias", "--description", "AgentDash managed template"],
          input.apiKey,
        );
      } else {
        await backup(r.template);
      }
      await applyToProfile(r, r.template, input);

      const profiles = companyAgentProfiles(r, opts.agentIds);
      for (const profile of profiles) {
        await backup(profile);
        try {
          await applyToProfile(r, profile, input);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`agent profile ${profile}: ${reason}`);
        }
      }

      // 6. Key-free marker.
      await writeFile(
        join(templateDir, HERMES_PROVIDER_MARKER),
        JSON.stringify(
          { companyId, provider: input.provider, model: input.model, configuredAt: r.now().toISOString() },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );

      return { provider: input.provider, model: input.model, template: r.template, profilesUpdated: profiles.length };
    } catch (error) {
      for (const { profile, backedUp } of touched) {
        for (const file of PROFILE_FILES) {
          const target = join(r.profilesDir, profile, file);
          if (backedUp.includes(file)) {
            await copyFile(join(backupRoot, profile, file), target).catch(() => undefined);
          } else {
            await rm(target, { force: true }).catch(() => undefined);
          }
        }
      }
      if (!templateExisted) {
        await r.runHermes(["profile", "delete", r.template, "-y"]).catch(() => undefined);
        await rm(templateDir, { recursive: true, force: true }).catch(() => undefined);
      }
      if (secretRestore) await secretRestore().catch(() => undefined);
      if (error instanceof HermesProviderSetupError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new HermesProviderSetupError(
        500,
        "hermes_config_failed",
        `The key works, but Hermes could not save the provider settings (${redactKey(reason, input.apiKey)}). Nothing was changed.`,
      );
    } finally {
      await rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}

// ---------------------------------------------------------------------------
// Reconcile: the secret is the source of truth
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  status: "not_configured" | "no_secret" | "ok";
  /** Profiles whose key, provider or model had to be rewritten. */
  updated: string[];
  failed: string[];
}

async function profileHasKey(r: ReturnType<typeof resolveDeps>, profile: string, envVar: string, value: string) {
  try {
    const env = await readFile(join(r.profilesDir, profile, ".env"), "utf8");
    return env.split(/\r?\n/).includes(`${envVar}=${value}`);
  } catch {
    return false;
  }
}

/**
 * Re-materialise the company's key from its secret into the template and the
 * given agent profiles. Does nothing unless the template's marker names this
 * company. Profiles that already hold the key are left alone.
 */
export async function reconcileHermesProviderFromSecret(
  companyId: string,
  opts: { agentIds: readonly string[] },
  deps: HermesProviderSetupDeps = {},
): Promise<ReconcileResult> {
  const r = resolveDeps(deps);
  const marker = await readMarker(r);
  if (!marker?.provider || !marker.model || marker.companyId !== companyId) {
    return { status: "not_configured", updated: [], failed: [] };
  }
  if (!r.secrets) return { status: "no_secret", updated: [], failed: [] };
  const apiKey = await r.secrets.get(companyId, HERMES_PROVIDER_SECRET_NAME);
  if (!apiKey) return { status: "no_secret", updated: [], failed: [] };
  const input: HermesProviderInput = { provider: marker.provider, apiKey, model: marker.model };
  const envVar = HERMES_PROVIDER_SPECS[marker.provider].envVar;

  return r.lock(hermesProviderLockKey(r.template), async () => {
    const updated: string[] = [];
    const failed: string[] = [];
    for (const profile of [r.template, ...companyAgentProfiles(r, opts.agentIds)]) {
      if (!existsSync(join(r.profilesDir, profile))) continue;
      if (await profileHasKey(r, profile, envVar, apiKey)) continue;
      try {
        await applyToProfile(r, profile, input);
        updated.push(profile);
      } catch {
        failed.push(profile);
      }
    }
    return { status: "ok", updated, failed };
  });
}
