// AgentDash (security, #737): the facts the host-execution policy needs about
// the company and agent a configuration belongs to. Kept out of
// adapter-host-execution-policy.ts so that module stays pure.
import type { HostExecutionContext } from "./adapter-host-execution-policy.js";
import { agentProfileName, hermesManagedProfilesEnabled } from "./hermes-profile.js";

/**
 * `companyId` lets `*Path` values inside the company's instructions area
 * through. With managed Hermes profiles on (hosted boxes), `hermesProfiles`
 * holds the one value a non-admin may pass to `-p`/`--profile`: the agent's
 * own profile `agentdash-<agentId>`. The run path keeps only that profile
 * (registry.ts), so accepting another agent's profile here would store a flag
 * every run silently drops. A configuration with no agent yet (create, hire,
 * import of a new agent) may name no profile at all: its wrapper already runs
 * `hermes -p <its own profile>`.
 */
export function hostExecutionContextForCompany(
  companyId: string,
  opts: { agentId?: string | null } = {},
): HostExecutionContext {
  if (!hermesManagedProfilesEnabled()) return { companyId };
  return {
    companyId,
    hermesProfiles: new Set(opts.agentId ? [agentProfileName(opts.agentId)] : []),
  };
}
