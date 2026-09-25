// AgentDash (#726, closes #450 for hosted boxes): the hosted-box boot guard.
//
// A hosted agentdash.cloud box is on the public internet, holds one customer's
// data and runs agents that read untrusted content. `local_trusted` — where the
// synthetic `local-board` actor can read every company (#450) — is right on a
// founder's own machine and never right there. So when the box says it is
// hosted (`AGENTDASH_DEPLOYMENT_KIND=hosted`), the server refuses to start
// unless every precondition below holds, and names each one that does not.
//
// Nothing here runs when the flag is unset: local dev (`pnpm dev` in
// local_trusted), on-prem and every existing self-hoster boot exactly as before.

import type { DeploymentMode } from "@paperclipai/shared";
import { isHostedBox } from "./services/license.js";

export interface HostedBoxGuardConfig {
  deploymentMode: DeploymentMode;
  authDisableSignUp: boolean;
}

function listFromEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Every hosted-box precondition that does not hold, as operator-facing lines
 * naming the setting to change. Empty when the box is not hosted.
 */
export function hostedBoxConfigErrors(
  config: HostedBoxGuardConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!isHostedBox(env)) return [];
  const errors: string[] = [];

  if (config.deploymentMode !== "authenticated") {
    errors.push(
      `PAPERCLIP_DEPLOYMENT_MODE is "${config.deploymentMode}"; a hosted box must run "authenticated". `
        + "local_trusted gives every request the local-board actor, which can read every company (#450).",
    );
  }

  const publicUrl = env.PAPERCLIP_PUBLIC_URL?.trim() ?? "";
  if (!publicUrl) {
    errors.push(
      "PAPERCLIP_PUBLIC_URL is not set; a hosted box must name its public https:// address "
        + "(OAuth issuer, approval links and connect commands are built from it).",
    );
  } else {
    let protocol: string | null = null;
    try {
      protocol = new URL(publicUrl).protocol;
    } catch {
      protocol = null;
    }
    if (protocol !== "https:") {
      errors.push(`PAPERCLIP_PUBLIC_URL must be an https:// URL on a hosted box (got "${publicUrl}").`);
    }
  }

  if (env.AGENTDASH_HERMES_MANAGED_PROFILES?.trim() !== "true") {
    errors.push(
      "AGENTDASH_HERMES_MANAGED_PROFILES must be \"true\" on a hosted box, so every agent runs in its own Hermes profile.",
    );
  }

  const inviteGateOn = env.AGENTDASH_REQUIRE_SIGNUP_INVITE_CODE?.trim() === "true";
  const inviteCodes = [
    ...listFromEnv(env.AGENTDASH_INVITE_CODES),
    ...listFromEnv(env.AGENTDASH_MK_INVITE_CODES),
  ];
  const signUpGated = config.authDisableSignUp || (inviteGateOn && inviteCodes.length > 0);
  if (!signUpGated) {
    errors.push(
      inviteGateOn
        ? "AGENTDASH_REQUIRE_SIGNUP_INVITE_CODE=true but AGENTDASH_INVITE_CODES is empty; "
          + "set the invite codes, or set PAPERCLIP_AUTH_DISABLE_SIGN_UP=true."
        : "Sign-up is open to anyone; a hosted box must gate it. Set AGENTDASH_REQUIRE_SIGNUP_INVITE_CODE=true "
          + "with AGENTDASH_INVITE_CODES, or set PAPERCLIP_AUTH_DISABLE_SIGN_UP=true.",
    );
  }

  return errors;
}

/** Throws one error naming every failed precondition. No-op off hosted boxes. */
export function assertHostedBoxConfig(
  config: HostedBoxGuardConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const errors = hostedBoxConfigErrors(config, env);
  if (errors.length === 0) return;
  throw new Error(
    "Refusing to start: AGENTDASH_DEPLOYMENT_KIND=hosted but this configuration is not safe for a hosted box.\n"
      + errors.map((line) => `  - ${line}`).join("\n"),
  );
}
