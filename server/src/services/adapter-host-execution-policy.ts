// AgentDash (security): one classifier for "does this adapter configuration
// decide WHAT runs on the host?", shared by every route that writes or probes
// an adapterConfig — agent create, hire, update and rollback, hire approvals,
// company import, issue assignee overrides, join-request approval, the
// adapter test-environment probe and the onboarding setup-adapter preset.
//
// Why instance admin: a hosted box is one tenant, and its founder is instance
// admin. Anyone else — invited teammates, company owners included — must not
// choose the binary an agent spawns, its argv, its environment or its working
// directory: that is host code execution on the next heartbeat, with company
// secrets bound to the agent resolved into the child's env.
//
// What stays open to everyone who may configure agents: the adapter's default
// command, the Hermes preset (default `hermes` binary, `-p <profile>`,
// `--reasoning-effort <level>` and a few other allowlisted flags), empty
// values (they select the server default), and any value that is unchanged
// from what is already stored — so an edit form that resends the stored
// configuration never trips the gate. The comparison is against the stored
// row on the server, never against anything the client claims.

import { forbidden, unprocessable } from "../errors.js";
import { normalizeHumanRole } from "./company-member-roles.js";
import { checkCompanyInstructionsPath } from "./instructions-root-confinement.js";
import { defaultHermesCommand } from "./adapter-command-resolution.js";
import { HERMES_PROVIDER_SPECS } from "./hermes-provider-setup.js";
// AgentDash (#737): the one managed-profiles helper (hermes-profile.ts); it
// reads the hosted flag through license.ts `isHostedBox`.
import { hermesManagedProfilesEnabled } from "./hermes-profile.js";

/** The subset of `req.actor` this policy reads. */
export interface HostExecutionActor {
  type: "board" | "agent" | "none";
  source?: string;
  isInstanceAdmin?: boolean;
  memberships?: Array<{ companyId: string; membershipRole?: string | null; status?: string }>;
}

/**
 * adapterConfig keys that decide what runs on the host: the binary
 * (`command`, `hermesCommand`, `agentCommand`, ...), its argv (`args`,
 * `extraArgs`), its environment (`env`), its working directory (`cwd`) and the
 * CLI state/home directories the CLI loads config — and hooks — from.
 *
 * `*Path` keys (#737): `instructionsFilePath`, `instructionsRootPath`,
 * `agentsMdPath` and friends name host files the server reads into the prompt
 * and host directories it writes bundle files into. A non-admin may only point
 * them inside this company's instructions area under the instance home (see
 * instructions-root-confinement.ts).
 */
const HOST_EXECUTION_CONFIG_KEY = /^(command|args|env|cwd)$|(Command|Args|Env|Cwd|Dir|Home|Path)$/;

/**
 * Subtrees with their own gate.
 * `workspaceStrategy.{provision,teardown}Command` is checked by
 * `assertHostWorkspaceCommandAuthority` in routes/workspace-command-authz.ts,
 * the same check projects, project workspaces, issues and execution workspaces
 * use. Since #735 it applies this module's authority rule
 * (`actorMaySetHostWorkspaceCommand`: instance admin only, agents never).
 */
const SEPARATELY_GATED_SUBTREES = new Set(["workspaceStrategy"]);

export function isHostExecutionConfigKey(key: string): boolean {
  return HOST_EXECUTION_CONFIG_KEY.test(key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEmptyConfigValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.keys(value).length === 0;
  return false;
}

/**
 * Stored env values are `{ type: "plain", value }` envelopes; a client may
 * resend either the envelope or the bare string. Compare them as equal.
 */
function comparable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(comparable);
  if (isRecord(value)) {
    if (value.type === "plain" && "value" in value && Object.keys(value).length === 2) {
      return comparable(value.value);
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      out[key] = comparable(value[key]);
    }
    return out;
  }
  return value;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));
}

// ---------------------------------------------------------------------------
// Curated, known-safe values
// ---------------------------------------------------------------------------

function envCommand(name: string): string | null {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** The command each built-in adapter runs when none is configured. */
export function defaultAdapterCommands(adapterType: string | null | undefined): string[] {
  const withEnv = (defaults: string[], envName: string) => {
    const configured = envCommand(envName);
    return configured ? [...defaults, configured] : defaults;
  };
  switch (adapterType) {
    case "hermes_local": {
      // AgentDash (#735): the absolute path the default resolved to at boot
      // is the same binary, so it counts as the default too.
      const commands = withEnv(["hermes"], "AGENTDASH_HERMES_COMMAND");
      const pinned = defaultHermesCommand();
      return commands.includes(pinned) ? commands : [...commands, pinned];
    }
    case "codex_local":
      return withEnv(["codex", "codex-acp"], "AGENTDASH_CODEX_COMMAND");
    case "claude_local":
      return ["claude"];
    case "gemini_local":
      return ["gemini"];
    case "opencode_local":
      return ["opencode"];
    case "pi_local":
      return ["pi"];
    case "cursor":
      return ["agent"];
    default:
      return [];
  }
}

/** Keys that name the adapter binary itself. */
const COMMAND_KEYS_BY_ADAPTER: Record<string, string[]> = {
  hermes_local: ["hermesCommand", "command"],
};

function commandKeysFor(adapterType: string | null | undefined): string[] {
  return (adapterType && COMMAND_KEYS_BY_ADAPTER[adapterType]) || ["command"];
}

export const HERMES_REASONING_EFFORTS = ["low", "medium", "high"] as const;

const HERMES_PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const POSITIVE_INT = /^[1-9][0-9]{0,5}$/;

/**
 * Hermes CLI flags a non-admin may pass through `extraArgs`. Each entry maps
 * the flag spelling to a value validator, or `null` for a bare switch.
 */
const HERMES_PROFILE_FLAGS = new Set(["-p", "--profile"]);
const HERMES_SAFE_FLAGS: Record<string, ((value: string) => boolean) | null> = {
  "-p": (v) => HERMES_PROFILE_NAME.test(v),
  "--profile": (v) => HERMES_PROFILE_NAME.test(v),
  "--reasoning-effort": (v) => (HERMES_REASONING_EFFORTS as readonly string[]).includes(v),
  "--max-turns": (v) => POSITIVE_INT.test(v),
  "--checkpoints": null,
  "-v": null,
  "--verbose": null,
};

/**
 * True when every token of a Hermes `extraArgs` list is an allowlisted flag.
 * Validates the exact array the adapter will pass to Hermes: no trimming, no
 * dropping, and an empty or whitespace-bearing token is refused, because it
 * would reach the CLI as a stray argument. A string is not accepted — the
 * adapter reads `extraArgs` as an array.
 *
 * With managed profiles on (#737), a profile value must also be in
 * `options.allowedProfiles`: the agent's own profile when the configuration
 * belongs to an existing agent, nothing otherwise. That is exactly what the run
 * path keeps (`stripForeignHermesProfileConfig`, adapters/hermes-profile-args.ts),
 * so the write-time gate never accepts a value the run would silently drop.
 * When the caller supplies no set, every profile flag is refused.
 */
export function isSafeHermesExtraArgs(
  value: unknown,
  options: { allowedProfiles?: ReadonlySet<string> | null; env?: NodeJS.ProcessEnv } = {},
): boolean {
  const restrictProfiles = hermesManagedProfilesEnabled(options.env);
  const profileAllowed = (flag: string, profile: string) =>
    !HERMES_PROFILE_FLAGS.has(flag) || !restrictProfiles || (options.allowedProfiles?.has(profile) ?? false);
  if (!Array.isArray(value) || value.length === 0) return false;
  if (!value.every((t) => typeof t === "string" && t.length > 0 && !/\s/.test(t))) return false;
  const tokens = value as string[];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const eq = token.indexOf("=");
    if (token.startsWith("--") && eq > 0) {
      const flag = token.slice(0, eq);
      const validator = HERMES_SAFE_FLAGS[flag];
      if (!validator || !validator(token.slice(eq + 1))) return false;
      if (!profileAllowed(flag, token.slice(eq + 1))) return false;
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(HERMES_SAFE_FLAGS, token)) return false;
    const validator = HERMES_SAFE_FLAGS[token];
    if (validator === null) continue;
    const next = tokens[i + 1];
    if (next === undefined || !validator!(next)) return false;
    if (!profileAllowed(token, next)) return false;
    i += 1;
  }
  return true;
}


function isCuratedTopLevelValue(
  adapterType: string | null | undefined,
  key: string,
  value: unknown,
  context: HostExecutionContext,
): boolean {
  if (commandKeysFor(adapterType).includes(key)) {
    return typeof value === "string" && defaultAdapterCommands(adapterType).includes(value.trim());
  }
  if (adapterType === "hermes_local" && key === "extraArgs") {
    return isSafeHermesExtraArgs(value, { allowedProfiles: context.hermesProfiles });
  }
  if (key.endsWith("Path") && context.companyId) {
    return checkCompanyInstructionsPath(context.companyId, value).ok;
  }
  return false;
}

/** Hermes reads `hermesCommand` and falls back to `command` (registry.normalizeHermesConfig). */
function storedTopLevelAliases(
  adapterType: string | null | undefined,
  key: string,
  stored: Record<string, unknown> | null,
): unknown[] {
  if (!stored) return [];
  const values = [stored[key]];
  if (adapterType === "hermes_local" && (key === "hermesCommand" || key === "command")) {
    values.push(stored[key === "hermesCommand" ? "command" : "hermesCommand"]);
  }
  return values.filter((v) => v !== undefined);
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * What the policy needs to know about the company the configuration belongs to.
 * Build it with `hostExecutionContextForCompany` (host-execution-context.ts).
 */
export interface HostExecutionContext {
  /** Lets a `*Path` value inside this company's instructions area through. */
  companyId?: string | null;
  /** The Hermes profiles a `-p` may name: the agent's own (managed profiles only). */
  hermesProfiles?: ReadonlySet<string> | null;
}

export interface HostExecutionCheckInput extends HostExecutionContext {
  adapterType: string | null | undefined;
  /** The adapterConfig (or adapterConfig patch) the caller sent. */
  adapterConfig: unknown;
  /** The adapterConfig already stored for this entity, when there is one. */
  stored?: unknown;
  /** Path prefix used in the returned field names. */
  prefix?: string;
}

/**
 * Return the paths of host-execution fields in `adapterConfig` that a
 * non-instance-admin may not set: non-empty, not a curated safe value, and
 * different from the stored value at the same path.
 */
export function findRestrictedHostExecutionFields(input: HostExecutionCheckInput): string[] {
  const context: HostExecutionContext = { companyId: input.companyId, hermesProfiles: input.hermesProfiles };
  return walk(input.adapterType, context, input.adapterConfig, isRecord(input.stored) ? input.stored : null, input.prefix ?? "adapterConfig", 0);
}

function walk(
  adapterType: string | null | undefined,
  context: HostExecutionContext,
  value: unknown,
  stored: unknown,
  prefix: string,
  depth: number,
): string[] {
  const found: string[] = [];
  if (Array.isArray(value)) {
    const storedArray = Array.isArray(stored) ? stored : [];
    value.forEach((item, index) => {
      found.push(...walk(adapterType, context, item, storedArray[index], `${prefix}.${index}`, depth + 1));
    });
    return found;
  }
  if (!isRecord(value)) return found;
  const storedRecord = isRecord(stored) ? stored : null;
  for (const [key, child] of Object.entries(value)) {
    if (depth === 0 && SEPARATELY_GATED_SUBTREES.has(key)) continue;
    const path = `${prefix}.${key}`;
    if (!isHostExecutionConfigKey(key)) {
      found.push(...walk(adapterType, context, child, storedRecord?.[key], path, depth + 1));
      continue;
    }
    if (isEmptyConfigValue(child)) continue;
    const storedCandidates =
      depth === 0 ? storedTopLevelAliases(adapterType, key, storedRecord) : storedRecord ? [storedRecord[key]] : [];
    if (storedCandidates.some((candidate) => sameValue(child, candidate))) continue;
    if (depth === 0 && isCuratedTopLevelValue(adapterType, key, child, context)) continue;
    found.push(path);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Authority
// ---------------------------------------------------------------------------

/** Instance admins (and the local_trusted implicit board) may set anything. */
export function actorMaySetHostExecutionConfig(actor: HostExecutionActor | null | undefined): boolean {
  return (
    !!actor &&
    actor.type === "board" &&
    (actor.source === "local_implicit" || actor.isInstanceAdmin === true)
  );
}

export function hostExecutionForbiddenMessage(paths: string[]): string {
  return (
    "Instance admin access required to set a custom command, arguments, environment, working " +
    `directory or host path for an agent adapter (${paths.join(", ")}). Leave these fields empty to use the ` +
    "server default, or ask the instance admin to set them."
  );
}

/**
 * Throw 403 when a non-instance-admin sets a restricted host-execution field.
 * Pass every adapterConfig the request writes or probes; pass `stored` so an
 * unchanged value is accepted. `context` (company id, provisioned Hermes
 * profiles) applies to every input that does not carry its own.
 */
export function assertHostExecutionConfigAllowed(
  actor: HostExecutionActor | null | undefined,
  inputs: HostExecutionCheckInput | HostExecutionCheckInput[],
  context: HostExecutionContext = {},
): void {
  if (actorMaySetHostExecutionConfig(actor)) return;
  const list = Array.isArray(inputs) ? inputs : [inputs];
  const paths = list.flatMap((input) =>
    findRestrictedHostExecutionFields({
      ...input,
      companyId: input.companyId ?? context.companyId,
      hermesProfiles: input.hermesProfiles ?? context.hermesProfiles,
    }),
  );
  if (paths.length > 0) throw forbidden(hostExecutionForbiddenMessage(paths));
}

/**
 * The `runtimeConfig.modelProfiles.<key>.adapterConfig` entries also merge
 * into the run config, so they are checked like the top-level adapterConfig.
 */
export function runtimeConfigHostExecutionInputs(
  adapterType: string | null | undefined,
  runtimeConfig: unknown,
  storedRuntimeConfig?: unknown,
): HostExecutionCheckInput[] {
  const profiles = isRecord(runtimeConfig) && isRecord(runtimeConfig.modelProfiles) ? runtimeConfig.modelProfiles : null;
  if (!profiles) return [];
  const storedProfiles =
    isRecord(storedRuntimeConfig) && isRecord(storedRuntimeConfig.modelProfiles) ? storedRuntimeConfig.modelProfiles : null;
  const inputs: HostExecutionCheckInput[] = [];
  for (const [profileKey, profile] of Object.entries(profiles)) {
    if (!isRecord(profile) || !isRecord(profile.adapterConfig)) continue;
    const storedProfile = storedProfiles && isRecord(storedProfiles[profileKey]) ? storedProfiles[profileKey] : null;
    inputs.push({
      adapterType,
      adapterConfig: profile.adapterConfig,
      stored: storedProfile ? storedProfile.adapterConfig : undefined,
      prefix: `runtimeConfig.modelProfiles.${profileKey}.adapterConfig`,
    });
  }
  return inputs;
}

// ---------------------------------------------------------------------------
// Onboarding setup-adapter presets
// ---------------------------------------------------------------------------

/**
 * Presets a company owner may apply without being instance admin. Hermes
 * collects no key and writes only `AGENTDASH_DEFAULT_ADAPTER=hermes_local`;
 * the key-bearing presets rewrite process-wide provider credentials and stay
 * instance-admin only.
 */
export const COMPANY_OWNER_ADAPTER_PRESETS: ReadonlySet<string> = new Set(["hermes"]);

function isActiveCompanyOwner(actor: HostExecutionActor): boolean {
  return (actor.memberships ?? []).some(
    (m) => m.status === "active" && normalizeHumanRole(m.membershipRole) === "admin",
  );
}

export function actorMayApplyAdapterPreset(
  actor: HostExecutionActor | null | undefined,
  preset: string,
): boolean {
  if (actorMaySetHostExecutionConfig(actor)) return true;
  if (!actor || actor.type !== "board") return false;
  return COMPANY_OWNER_ADAPTER_PRESETS.has(preset) && isActiveCompanyOwner(actor);
}

// ---------------------------------------------------------------------------
// Workspace commands and project env (#735)
// ---------------------------------------------------------------------------

/**
 * Host-executed workspace commands — `workspaceStrategy.provisionCommand` and
 * `teardownCommand` (agent adapterConfig, project execution workspace policy,
 * issue execution workspace settings and assignee overrides), a project
 * workspace's `cleanupCommand`, and an execution workspace's config commands —
 * are raw shell run on the host. They used to need only `agents:create`, which
 * company owners and CEO agents can hold. The rule is now the one for every
 * other host-execution field: instance admin (or the local_trusted implicit
 * board) only, and never an agent key.
 */
export function actorMaySetHostWorkspaceCommand(actor: HostExecutionActor | null | undefined): boolean {
  return actorMaySetHostExecutionConfig(actor);
}

/**
 * Project env (#735). A project's `env` is merged into every run of every
 * agent working in that project, and any member who can edit the project can
 * set it, so it gets two checks:
 *
 * 1. Key names must match `^[A-Z][A-Z0-9_]{0,63}$`. That keeps out lower-case
 *    tool settings (`npm_config_*`), exported shell functions
 *    (`BASH_FUNC_x%%`) and other names a shell or runtime treats specially.
 * 2. A denylist, compared case-insensitively, of keys that execute code,
 *    change trust, redirect traffic, or swap the box's credentials:
 *    - binary, library and interpreter lookup: PATH, LD_*, DYLD_*,
 *      NODE_OPTIONS, NODE_PATH, PYTHON*, PERL5LIB/PERL5OPT/PERLLIB,
 *      RUBYOPT/RUBYLIB, GEM_*, CLASSPATH, JAVA_TOOL_OPTIONS and friends,
 *      DOTNET_*, CORECLR_*, COMPlus_*, BUN_*, NPM_CONFIG_*, PIP_*, UV_*,
 *      CARGO_*, RUSTC, RUSTC_WRAPPER, GOFLAGS, GOPROXY, GONOSUMDB, GOPRIVATE,
 *      GCONV_PATH, OPENSSL_CONF, OPENSSL_MODULES;
 *    - shells and helpers that run commands: BASH_ENV, ENV, SHELL,
 *      SHELLOPTS, BASHOPTS, PS4, PROMPT_COMMAND, IFS, EDITOR, VISUAL, PAGER,
 *      BROWSER, LESSOPEN, LESSCLOSE, SSH_ASKPASS, every GIT_*;
 *    - homes that load config and hooks: HOME, HERMES_HOME, PAPERCLIP_HOME,
 *      CODEX_HOME, CLAUDE_HOME, CLAUDE_CONFIG_DIR, GNUPGHOME, ZDOTDIR, XDG_*
 *      (other `*_HOME` keys such as JAVA_HOME stay open);
 *    - trust and traffic: *_PROXY, *_BASE_URL, *_API_URL, *_API_BASE,
 *      *_ENDPOINT, SSL_CERT_*, SSLKEYLOGFILE, NODE_EXTRA_CA_CERTS,
 *      NODE_TLS_REJECT_UNAUTHORIZED, REQUESTS_CA_BUNDLE, CURL_CA_BUNDLE, TMPDIR;
 *    - provider credentials, so project env cannot swap the box's model
 *      provider key: ANTHROPIC_*, OPENAI_*, ZAI_*, GLM_*, OPENROUTER_* and each
 *      Hermes provider's key variable (hermes-provider-setup.ts);
 *    - the control plane's own variables: PAPERCLIP_*, AGENTDASH_*, HERMES_*.
 */
export const PROJECT_ENV_KEY_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

const EXECUTION_AFFECTING_ENV_EXACT = new Set([
  "PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "BASH_ENV",
  "ENV",
  "SHELL",
  "SHELLOPTS",
  "BASHOPTS",
  "PS4",
  "PROMPT_COMMAND",
  "IFS",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "BROWSER",
  "LESSOPEN",
  "LESSCLOSE",
  "SSH_ASKPASS",
  "HOME",
  "HERMES_HOME",
  "PAPERCLIP_HOME",
  "CODEX_HOME",
  "CLAUDE_HOME",
  "CLAUDE_CONFIG_DIR",
  "GNUPGHOME",
  "ZDOTDIR",
  "PERL5LIB",
  "PERL5OPT",
  "PERLLIB",
  "RUBYOPT",
  "RUBYLIB",
  "CLASSPATH",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "RUSTC",
  "RUSTC_WRAPPER",
  "RUSTC_WORKSPACE_WRAPPER",
  "GOFLAGS",
  "GOPROXY",
  "GONOSUMDB",
  "GOPRIVATE",
  "GOSUMDB",
  "GOINSECURE",
  "GCONV_PATH",
  "OPENSSL_CONF",
  "OPENSSL_MODULES",
  "SSLKEYLOGFILE",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "TMPDIR",
  ...Object.values(HERMES_PROVIDER_SPECS).map((spec) => spec.envVar.toUpperCase()),
]);
const EXECUTION_AFFECTING_ENV_PREFIXES = [
  "LD_",
  "DYLD_",
  "PYTHON",
  "GEM_",
  "DOTNET_",
  "CORECLR_",
  "COMPLUS_",
  "BUN_",
  "NPM_CONFIG_",
  "PIP_",
  "UV_",
  "CARGO_",
  "GIT_",
  "XDG_",
  "SSL_CERT_",
  "BASH_FUNC_",
  "ANTHROPIC_",
  "OPENAI_",
  "ZAI_",
  "GLM_",
  "OPENROUTER_",
  "PAPERCLIP_",
  "AGENTDASH_",
  "HERMES_",
];
const EXECUTION_AFFECTING_ENV_SUFFIXES = ["_PROXY", "_BASE_URL", "_API_URL", "_API_BASE", "_ENDPOINT"];

export function isValidProjectEnvKeyName(key: string): boolean {
  return PROJECT_ENV_KEY_NAME.test(key);
}

/** Denylist check, case-insensitive. */
export function isExecutionAffectingEnvKey(key: string): boolean {
  const upper = key.trim().toUpperCase();
  if (upper.length === 0) return false;
  if (EXECUTION_AFFECTING_ENV_EXACT.has(upper)) return true;
  if (EXECUTION_AFFECTING_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) return true;
  return EXECUTION_AFFECTING_ENV_SUFFIXES.some((suffix) => upper.endsWith(suffix));
}

/** A project env key is allowed when its name is valid and it is not denylisted. */
export function isAllowedProjectEnvKey(key: string): boolean {
  return isValidProjectEnvKeyName(key) && !isExecutionAffectingEnvKey(key);
}

/** The keys of an env record (plain values or binding envelopes) that project env refuses. */
export function findRefusedProjectEnvKeys(env: unknown): string[] {
  if (!isRecord(env)) return [];
  return Object.keys(env).filter((key) => !isAllowedProjectEnvKey(key)).sort();
}

/** Drop refused keys from a resolved env map (run time). */
export function filterExecutionAffectingEnv<T>(env: Record<string, T>): { env: Record<string, T>; dropped: string[] } {
  const kept: Record<string, T> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (isAllowedProjectEnvKey(key)) kept[key] = value;
    else dropped.push(key);
  }
  return { env: kept, dropped: dropped.sort() };
}

/**
 * Write-time rule for a project's `env`:
 * - an agent key may not change it at all — it would reach every other agent
 *   working in the project;
 * - nobody, instance admin included, may use an invalid key name or a
 *   denylisted key; the run path drops them anyway, and an instance admin who
 *   needs PATH or a CLI home sets it on the agent's own `adapterConfig.env`,
 *   which is instance-admin only.
 * Values unchanged from `stored` pass for agents, so a PATCH that resends the
 * project is not refused for echoing its env.
 */
export function assertProjectEnvAllowed(
  actor: HostExecutionActor | null | undefined,
  env: unknown,
  stored?: unknown,
): void {
  if (env === undefined) return;
  if (actor?.type === "agent" && !sameValue(env ?? null, stored ?? null)) {
    throw forbidden("Agent keys cannot change a project's env; ask a board member to set it.");
  }
  const keys = isRecord(env) ? Object.keys(env) : [];
  const invalid = keys.filter((key) => !isValidProjectEnvKeyName(key)).sort();
  if (invalid.length > 0) {
    throw unprocessable(
      `Project env key names must be upper-case letters, digits and underscores, starting with a letter ` +
        `(at most 64 characters): ${invalid.join(", ")}.`,
    );
  }
  const denied = keys.filter(isExecutionAffectingEnvKey).sort();
  if (denied.length > 0) {
    throw unprocessable(
      `Project env cannot set execution-affecting variables (${denied.join(", ")}). They would change ` +
        "what runs, or which credentials are used, for every agent in the project. An instance admin can " +
        "set them on an agent's adapterConfig.env instead.",
    );
  }
}
