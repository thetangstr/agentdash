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
import { writeFile as fsWriteFile, rm as fsRm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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
  env?: NodeJS.ProcessEnv;
}

function resolved(deps: HermesProfileDeps = {}) {
  const env = deps.env ?? process.env;
  const hermesBin = deps.hermesBin ?? env.AGENTDASH_HERMES_COMMAND ?? "hermes";
  return {
    env,
    hermesBin,
    profilesDir: deps.profilesDir ?? join(homedir(), ".hermes", "profiles"),
    binDir: deps.binDir ?? join(homedir(), ".local", "bin"),
    run: deps.run ?? (async (args: string[]) => execFileAsync(hermesBin, args)),
    writeFile: deps.writeFile ?? ((p: string, c: string) => fsWriteFile(p, c, { mode: 0o600 })),
    writeWrapper: deps.writeWrapper ?? ((p: string, c: string) => fsWriteFile(p, c, { mode: 0o755 })),
    removeFile: deps.removeFile ?? ((p: string) => fsRm(p, { force: true })),
  };
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

  // Clone from a managed template via Hermes' native `--clone-from` so the
  // working provider auth carries over. A bare `create` + manually copying
  // .env/config.yaml/auth.json yields `HTTP 401: invalid api key` (verified on
  // the mini 2026-06-25) — the provider credentials are NOT fully captured by
  // copying those files; only `--clone-from` clones a working provider.
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
