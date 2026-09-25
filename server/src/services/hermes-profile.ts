// AgentDash: per-agent Hermes profile lifecycle (managed-harness runtime).
//
// Each AgentDash agent maps to one distinct Hermes profile (own model/provider,
// MCP, skills, identity, sessions, state). The managed provider credentials live
// in the profile — gateway-pointed when AGENTDASH_GATEWAY_* is set, else copied
// from a managed template — so no per-agent token is needed (token-independent).
//
// Per-run selection is the `hermes -p <profile>` flag, surfaced as an alias
// wrapper whose path is used as the agent's adapterConfig.hermesCommand. Verified
// live on the mini 2026-06-24 (see scripts/hermes/provision-agent-profile.sh).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir as fsMkdir, writeFile as fsWriteFile, rm as fsRm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isHostedBox } from "./license.js";

import { defaultHermesCommand } from "./adapter-command-resolution.js";

const execFileAsync = promisify(execFile);

/** Injectable seam so the lifecycle is unit-testable without a real Hermes. */
export interface HermesProfileDeps {
  /** path to the hermes binary */
  hermesBin?: string;
  /** ~/.hermes/profiles */
  profilesDir?: string;
  /** dir where alias wrappers are written (~/.local/bin) */
  binDir?: string;
  /** run a hermes subcommand */
  run?: (args: string[]) => Promise<{ stdout: string; stderr: string }>;
  /** write a file (the gateway-pointed .env) */
  writeFile?: (path: string, content: string) => Promise<void>;
  /** write the executable per-run alias wrapper (mode 0755) */
  writeWrapper?: (path: string, content: string) => Promise<void>;
  /** remove the alias wrapper file */
  removeFile?: (path: string) => Promise<void>;
  /** does a path exist (the wrapper) */
  exists?: (path: string) => boolean;
  env?: NodeJS.ProcessEnv;
}

function resolved(deps: HermesProfileDeps = {}) {
  const env = deps.env ?? process.env;
  // AgentDash (#735): the absolute path resolved at boot when there is one.
  const hermesBin = deps.hermesBin ?? defaultHermesCommand(env);
  return {
    env,
    hermesBin,
    profilesDir: deps.profilesDir ?? env.HERMES_PROFILES_DIR ?? join(homedir(), ".hermes", "profiles"),
    binDir: deps.binDir ?? env.AGENTDASH_HERMES_BIN_DIR ?? join(homedir(), ".local", "bin"),
    run: deps.run ?? (async (args: string[]) => execFileAsync(hermesBin, args)),
    writeFile: deps.writeFile ?? ((p: string, c: string) => fsWriteFile(p, c, { mode: 0o600 })),
    // AgentDash (#721): the wrapper dir may not exist yet on a fresh Volume.
    writeWrapper:
      deps.writeWrapper
      ?? (async (p: string, c: string) => {
        await fsMkdir(dirname(p), { recursive: true });
        await fsWriteFile(p, c, { mode: 0o755 });
      }),
    removeFile: deps.removeFile ?? ((p: string) => fsRm(p, { force: true })),
    exists: deps.exists ?? ((p: string) => existsSync(p)),
  };
}

/**
 * AgentDash: managed per-agent profiles are opt-in on a founder's own machine
 * (`AGENTDASH_HERMES_MANAGED_PROFILES=true`) and always on for a hosted box,
 * where every run must carry an explicit `-p <profile>` so its ledger is certain.
 */
export function hermesManagedProfilesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENTDASH_HERMES_MANAGED_PROFILES === "true" || isHostedBox(env);
}

/**
 * AgentDash (#721): on a hosted box a profile that cannot be provisioned fails
 * the run. Falling back to the root `hermes` command would run the agent on the
 * shared root profile and write its usage to the root ledger, silently.
 */
export function hermesProfilesFailClosed(env: NodeJS.ProcessEnv = process.env): boolean {
  return isHostedBox(env);
}

export const HERMES_PROFILE_PROVISION_ERROR_CODE = "hermes_profile_provision_failed";

/** Named failure for a managed profile that could not be provisioned (fail-closed mode). */
export class HermesProfileProvisionError extends Error {
  readonly code = HERMES_PROFILE_PROVISION_ERROR_CODE;
  readonly agentId: string | null;
  readonly profileName: string | null;
  constructor(message: string, opts: { agentId?: string | null; profileName?: string | null; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "HermesProfileProvisionError";
    this.agentId = opts.agentId ?? null;
    this.profileName = opts.profileName ?? null;
  }
}

/** Called after a profile is created or found, before its wrapper is written. */
export type AgentProfileProvisionedHook = (agentId: string, profileName: string) => Promise<void>;
let provisionedHook: AgentProfileProvisionedHook | null = null;

/** AgentDash (#725): registered at boot by hermes-provider-reconcile.ts. */
export function setAgentProfileProvisionedHook(hook: AgentProfileProvisionedHook | null): void {
  provisionedHook = hook;
}

/** Deterministic, Hermes-safe profile name (lowercase alphanumeric, one hyphen). */
export function agentProfileName(agentId: string): string {
  return `agentdash-${String(agentId).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}

/** The command an agent run should invoke (the profile's alias wrapper). */
export function agentProfileCommand(agentId: string, deps: HermesProfileDeps = {}): string {
  const r = resolved(deps);
  return join(r.binDir, agentProfileName(agentId));
}

export interface ProvisionResult {
  profileName: string;
  /** set this as adapterConfig.hermesCommand so every run is scoped to the profile */
  command: string;
  /** "gateway" when gateway-pointed, "template" when copied from a managed template */
  providerSource: "gateway" | "template";
}

/**
 * Create + configure + alias a per-agent profile. Idempotent-ish: re-running
 * create on an existing profile errors, so callers should treat "already exists"
 * as success (the deprovision/provision pair owns the lifecycle).
 */
export async function provisionAgentProfile(
  agentId: string,
  opts: { template?: string } = {},
  deps: HermesProfileDeps = {},
): Promise<ProvisionResult> {
  const r = resolved(deps);
  const profileName = agentProfileName(agentId);
  const template = opts.template ?? r.env.AGENTDASH_HERMES_PROFILE_TEMPLATE ?? "agentdash";

  // AgentDash (#721): a profile that already exists is kept. On a hosted box the
  // profiles live on the Volume, so after a redeploy the profile can be present
  // while its wrapper is being rewritten; `profile create` would error on it.
  const profileExists = r.exists(join(r.profilesDir, profileName));
  // Clone from a managed template via Hermes' native `--clone-from` so the
  // working provider auth carries over. A bare `create` + manually copying
  // .env/config.yaml/auth.json yields `HTTP 401: invalid api key` (verified on
  // the mini 2026-06-25) — the provider credentials are NOT fully captured by
  // copying those files; only `--clone-from` clones a working provider.
  if (!profileExists) {
    await r.run([
      "profile",
      "create",
      profileName,
      "--clone-from",
      template,
      "--no-alias",
      "--description",
      `AgentDash agent ${agentId}`,
    ]);
  }

  const gwBase = r.env.AGENTDASH_GATEWAY_BASE_URL?.trim();
  const gwKey = r.env.AGENTDASH_GATEWAY_API_KEY?.trim();
  let providerSource: "gateway" | "template";
  if (gwBase && gwKey) {
    // Overlay the managed gateway provider on the cloned base.
    await r.writeFile(
      join(r.profilesDir, profileName, ".env"),
      `HERMES_GATEWAY_BASE_URL=${gwBase}\nHERMES_GATEWAY_API_KEY=${gwKey}\n`,
    );
    providerSource = "gateway";
  } else {
    providerSource = "template";
  }

  // AgentDash (#725): let the provider-key service re-materialise the company's
  // key into the new profile from its secret before the wrapper exists, so a
  // failure here leaves no usable wrapper (and fails closed on a hosted box).
  if (provisionedHook) await provisionedHook(agentId, profileName);

  // Write the per-run alias wrapper directly with an absolute-resolving hermes
  // path. `hermes profile alias` emits `exec hermes -p ...` (bare), which fails
  // with exit 127 when the agent adapter spawns it from a PATH that omits the
  // hermes install dir (verified on the live box 2026-06-25). Prepending the
  // common install dirs makes the wrapper self-sufficient regardless of caller PATH.
  await r.writeWrapper(
    join(r.binDir, profileName),
    `#!/bin/sh\n` +
      `export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"\n` +
      `exec ${r.hermesBin} -p ${profileName} "$@"\n`,
  );
  return { profileName, command: agentProfileCommand(agentId, deps), providerSource };
}

/**
 * Return the per-agent managed-profile wrapper command, provisioning the profile
 * first if it is missing. This makes managed Hermes work for an agent created by
 * ANY path (direct API create, seed, import) — not only the hire-approval flow
 * that fires onHireApproved.
 *
 * Default (on-prem): returns undefined when there is no agentId or when
 * provisioning could not produce a usable wrapper, so callers fall back to the
 * default hermes command; provisioning errors are swallowed.
 *
 * `failClosed` (hosted box, #721): throws HermesProfileProvisionError instead,
 * so no run can fall back to the shared root profile.
 */
export async function ensureAgentProfileCommand(
  agentId: string | undefined | null,
  deps: HermesProfileDeps = {},
  opts: { failClosed?: boolean } = {},
): Promise<string | undefined> {
  if (!agentId) {
    if (opts.failClosed) {
      throw new HermesProfileProvisionError(
        "Hermes profile provisioning failed: the run has no agent id, so it has no managed profile.",
      );
    }
    return undefined;
  }
  const r = resolved(deps);
  const profileName = agentProfileName(agentId);
  const command = join(r.binDir, profileName);
  if (r.exists(command)) return command;
  let failure: unknown = null;
  try {
    await provisionAgentProfile(agentId, {}, deps);
  } catch (error) {
    /* non-fatal unless fail-closed — fall through to the existence re-check */
    failure = error;
  }
  if (r.exists(command)) return command;
  if (opts.failClosed) {
    const raw = failure instanceof Error ? failure.message : failure ? String(failure) : "the wrapper was not written";
    const reason = raw.trim().replace(/\s+/g, " ").slice(0, 500);
    throw new HermesProfileProvisionError(
      `Hermes profile provisioning failed for agent ${agentId} (profile ${profileName}): ${reason}. ` +
        "The run was not started on the shared root profile.",
      { agentId, profileName, cause: failure ?? undefined },
    );
  }
  return undefined;
}

/** Remove the alias wrapper and delete the profile. Best-effort; never throws. */
export async function deprovisionAgentProfile(agentId: string, deps: HermesProfileDeps = {}): Promise<void> {
  const r = resolved(deps);
  const profileName = agentProfileName(agentId);
  try {
    await r.removeFile(join(r.binDir, profileName));
  } catch {
    /* wrapper may not exist */
  }
  try {
    await r.run(["profile", "delete", profileName, "-y"]);
  } catch {
    /* profile may not exist */
  }
}
