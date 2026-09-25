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

import type { AuthBaseUrlMode, DeploymentMode } from "@paperclipai/shared";
import {
  configuredMicrosoftTenant,
  getConfiguredSocialProviders,
  MULTI_TENANT_MICROSOFT_TENANTS,
} from "./auth/social-providers.js";
import {
  acceptedSignupInviteCodes,
  envFlagEnabled,
  isWeakInviteCode,
  MIN_HOSTED_INVITE_CODE_LENGTH,
  mcpInviteValidationEnabled,
  selfServeBootstrapEnabled,
  signupInviteCodeRequired,
} from "./lib/signup-gate.js";
import { isHostedBox } from "./services/license.js";

export interface HostedBoxGuardConfig {
  deploymentMode: DeploymentMode;
  authDisableSignUp: boolean;
  /**
   * The auth base URL the app actually uses, resolved by `loadConfig` from
   * PAPERCLIP_AUTH_PUBLIC_BASE_URL, BETTER_AUTH_URL, BETTER_AUTH_BASE_URL,
   * PAPERCLIP_PUBLIC_URL or the config file.
   */
  authPublicBaseUrl: string | undefined;
  authBaseUrlMode: AuthBaseUrlMode;
}

/** Operator override for a multi-tenant Microsoft app on a hosted box. */
export const ALLOW_MULTI_TENANT_MICROSOFT_ENV = "AGENTDASH_HOSTED_ALLOW_MULTI_TENANT_MICROSOFT";

function httpsProblem(name: string, value: string): string | null {
  let protocol: string | null = null;
  try {
    protocol = new URL(value).protocol;
  } catch {
    protocol = null;
  }
  return protocol === "https:" ? null : `${name} must be an https:// URL on a hosted box (got "${value}").`;
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
    const problem = httpsProblem("PAPERCLIP_PUBLIC_URL", publicUrl);
    if (problem) errors.push(problem);
  }

  // The address Better Auth actually signs cookies and callbacks for. It can
  // come from a different variable than PAPERCLIP_PUBLIC_URL, so check it too.
  const authUrl = config.authPublicBaseUrl?.trim() ?? "";
  if (config.authBaseUrlMode !== "explicit" || !authUrl) {
    errors.push(
      "The auth base URL is not explicit; set PAPERCLIP_AUTH_PUBLIC_BASE_URL (or BETTER_AUTH_URL) "
        + "to the box's https:// address.",
    );
  } else {
    const problem = httpsProblem("The auth base URL (PAPERCLIP_AUTH_PUBLIC_BASE_URL / BETTER_AUTH_URL)", authUrl);
    if (problem) errors.push(problem);
  }

  if (!envFlagEnabled(env.AGENTDASH_HERMES_MANAGED_PROFILES)) {
    errors.push(
      "AGENTDASH_HERMES_MANAGED_PROFILES must be \"true\" on a hosted box, so every agent runs in its own Hermes profile.",
    );
  }

  const inviteGateOn = signupInviteCodeRequired(env);
  const inviteCodes = acceptedSignupInviteCodes(env);
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
  const weakCodes = inviteCodes.filter(isWeakInviteCode);
  if (weakCodes.length > 0) {
    errors.push(
      `${weakCodes.length} invite code(s) in AGENTDASH_INVITE_CODES / AGENTDASH_MK_INVITE_CODES are template `
        + `placeholders (CHANGEME...) or shorter than ${MIN_HOSTED_INVITE_CODE_LENGTH} characters; `
        + "replace them with real random codes (for example `openssl rand -hex 12`).",
    );
  }

  if (selfServeBootstrapEnabled(env) && !mcpInviteValidationEnabled(env)) {
    errors.push(
      "AGENTDASH_INVITE_VALIDATION=off with AGENTDASH_SELF_SERVE_BOOTSTRAP=true lets anyone claim the box "
        + "through MCP sign-up; unset AGENTDASH_INVITE_VALIDATION or turn self-serve bootstrap off.",
    );
  }

  if (getConfiguredSocialProviders(env).microsoft) {
    const tenant = configuredMicrosoftTenant(env);
    if (
      MULTI_TENANT_MICROSOFT_TENANTS.includes(tenant.toLowerCase())
      && !envFlagEnabled(env[ALLOW_MULTI_TENANT_MICROSOFT_ENV])
    ) {
      errors.push(
        `MICROSOFT_TENANT_ID is "${tenant}", which admits accounts from any Microsoft tenant; set it to the `
          + `customer's tenant id, or set ${ALLOW_MULTI_TENANT_MICROSOFT_ENV}=true to accept that deliberately.`,
      );
    }
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
