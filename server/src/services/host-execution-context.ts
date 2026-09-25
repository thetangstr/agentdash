// AgentDash (security, #737): the per-company facts the host-execution policy
// needs, loaded from the database once per request. Kept out of
// adapter-host-execution-policy.ts so that module stays pure and synchronous.
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import {
  hermesManagedProfilesActive,
  type HostExecutionContext,
} from "./adapter-host-execution-policy.js";
import { agentProfileName } from "./hermes-profile.js";

/**
 * `companyId` lets `*Path` values inside the company's instructions area
 * through. With managed Hermes profiles on (hosted boxes), `hermesProfiles`
 * lists the profiles provisioned for this company's agents — the only values
 * a non-admin may pass to `-p`/`--profile`.
 */
export async function hostExecutionContextForCompany(
  db: Db,
  companyId: string,
): Promise<HostExecutionContext> {
  if (!hermesManagedProfilesActive()) return { companyId };
  const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, companyId));
  return { companyId, hermesProfiles: new Set(rows.map((row) => agentProfileName(row.id))) };
}
