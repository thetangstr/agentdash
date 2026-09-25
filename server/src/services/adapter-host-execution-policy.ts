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

import { forbidden } from "../errors.js";
import { normalizeHumanRole } from "./company-member-roles.js";
import { checkCompanyInstructionsPath } from "./instructions-root-confinement.js";

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
 * Subtrees with their own, separately decided gate.
 * `workspaceStrategy.{provision,teardown}Command` is governed by
 * `assertHostWorkspaceCommandAuthority` (agents:create) in
 * routes/workspace-command-authz.ts, the same rule projects and issues use.
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
    case "hermes_local":
      return withEnv(["hermes"], "AGENTDASH_HERMES_COMMAND");
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

/**
 * AgentDash (#737): managed per-agent Hermes profiles are on — always on a
 * hosted box (`AGENTDASH_DEPLOYMENT_KIND=hosted`), opt-in elsewhere with
 * `AGENTDASH_HERMES_MANAGED_PROFILES=true`. Each agent then has its own profile
 * (`agentdash-<agentId>`) holding its provider credentials, and a `-p <profile>`
 * a non-admin chooses must name a profile provisioned for this company, so an
 * agent cannot borrow the credentials of the root, template or operator
 * profiles on the box (for example `ccworker`).
 */
export function hermesManagedProfilesActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.AGENTDASH_HERMES_MANAGED_PROFILES === "true" ||
    (env.AGENTDASH_DEPLOYMENT_KIND ?? "").trim().toLowerCase() === "hosted"
  );
}
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
 * `options.allowedProfiles` — the profiles provisioned for this company. When
 * the caller supplies no set, every profile flag is refused.
 */
export function isSafeHermesExtraArgs(
  value: unknown,
  options: { allowedProfiles?: ReadonlySet<string> | null; env?: NodeJS.ProcessEnv } = {},
): boolean {
  const restrictProfiles = hermesManagedProfilesActive(options.env);
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

/**
 * AgentDash (#737): run-time half of the profile rule. With managed profiles
 * on, the agent's wrapper already runs `hermes -p <its own profile>`, so a
 * `-p`/`--profile` in `extraArgs` can only redirect the run to another
 * profile's credentials. Drop every profile flag that does not name the
 * agent's own profile, whoever stored it. The run path has no database, so it
 * keeps the agent's own profile only; the write-time gate above applies the
 * company rule and answers with a 403.
 */
export function stripForeignHermesProfileArgs(
  extraArgs: unknown,
  ownProfile: string,
): { extraArgs: unknown; dropped: string[] } {
  if (!Array.isArray(extraArgs)) return { extraArgs, dropped: [] };
  const kept: unknown[] = [];
  const dropped: string[] = [];
  // Hermes parses its argv with argparse, which also accepts `-pNAME` and
  // unambiguous abbreviations of `--profile` (`--prof NAME`, `--prof=NAME`).
  const profileFlagOf = (token: string): { flag: string; inlineValue: string | null } | null => {
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = eq > 0 ? token.slice(0, eq) : token;
      if (name.length >= 4 && "--profile".startsWith(name)) {
        return { flag: name, inlineValue: eq > 0 ? token.slice(eq + 1) : null };
      }
      return null;
    }
    if (token === "-p") return { flag: "-p", inlineValue: null };
    if (token.startsWith("-p")) return { flag: "-p", inlineValue: token.slice(2) };
    return null;
  };
  for (let i = 0; i < extraArgs.length; i += 1) {
    const token = extraArgs[i];
    const parsed = typeof token === "string" ? profileFlagOf(token) : null;
    if (!parsed) {
      kept.push(token);
      continue;
    }
    if (parsed.inlineValue !== null) {
      if (parsed.inlineValue === ownProfile) kept.push(token);
      else dropped.push(parsed.inlineValue);
      continue;
    }
    const next = extraArgs[i + 1];
    if (typeof next === "string" && next === ownProfile) kept.push(token, next);
    else dropped.push(typeof next === "string" ? next : "");
    i += 1;
  }
  return { extraArgs: kept, dropped };
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
  /** Hermes profiles provisioned for this company (managed profiles only). */
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
