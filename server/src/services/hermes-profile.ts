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
import { writeFile as fsWriteFile, cp as fsCp } from "node:fs/promises";
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
  /** copy a managed template file into the profile */
  copyFile?: (src: string, dst: string) => Promise<void>;
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
    copyFile: deps.copyFile ?? ((s: string, d: string) => fsCp(s, d).then(() => undefined)),
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

  await r.run(["profile", "create", profileName, "--description", `AgentDash agent ${agentId}`]);

  const dst = join(r.profilesDir, profileName);
  const gwBase = r.env.AGENTDASH_GATEWAY_BASE_URL?.trim();
  const gwKey = r.env.AGENTDASH_GATEWAY_API_KEY?.trim();
  let providerSource: "gateway" | "template";
  if (gwBase && gwKey) {
    await r.writeFile(
      join(dst, ".env"),
      `HERMES_GATEWAY_BASE_URL=${gwBase}\nHERMES_GATEWAY_API_KEY=${gwKey}\n`,
    );
    providerSource = "gateway";
  } else {
    const src = join(r.profilesDir, template);
    for (const f of [".env", "config.yaml", "auth.json"]) {
      try {
        await r.copyFile(join(src, f), join(dst, f));
      } catch {
        // optional file; the template may not have all of them
      }
    }
    providerSource = "template";
  }

  await r.run(["profile", "alias", profileName]);
  return { profileName, command: agentProfileCommand(agentId, deps), providerSource };
}

/** Remove the alias wrapper and delete the profile. Best-effort; never throws. */
export async function deprovisionAgentProfile(agentId: string, deps: HermesProfileDeps = {}): Promise<void> {
  const r = resolved(deps);
  const profileName = agentProfileName(agentId);
  try {
    await r.run(["profile", "alias", profileName, "--remove"]);
  } catch {
    /* alias may not exist */
  }
  try {
    await r.run(["profile", "delete", profileName, "-y"]);
  } catch {
    /* profile may not exist */
  }
}
