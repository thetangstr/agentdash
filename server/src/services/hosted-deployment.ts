// AgentDash (MVL 1.0, #721 / #726): the hosted-box flag.
//
// A hosted agentdash.cloud box (one Railway service per customer) sets
// `AGENTDASH_DEPLOYMENT_KIND=hosted`. `deploymentKind()` in license.ts still
// reports "cloud" for it (anything but "on_prem" is the cloud SKU), so the
// flag narrows the cloud SKU rather than adding a third one.
//
// What the flag changes today:
// - Hermes managed per-agent profiles are always on (hermes-profile.ts).
// - A run whose profile cannot be provisioned fails with a named error
//   instead of falling back to the shared root `hermes` command.
// The boot guard in #726 reads the same flag.

export const HOSTED_DEPLOYMENT_KIND = "hosted";

export function isHostedDeployment(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.AGENTDASH_DEPLOYMENT_KIND ?? "").trim().toLowerCase() === HOSTED_DEPLOYMENT_KIND;
}
