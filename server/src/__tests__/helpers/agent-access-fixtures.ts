import { and, asc, eq } from "drizzle-orm";
import { activityLog, agentGovernancePolicies, companies, createDb } from "@paperclipai/db";
import {
  AGENT_ACCESS_POLICY_VERSION,
  DEFAULT_AGENT_GOVERNANCE_POLICY,
  type AgentAccessEnforcementMode,
  type AgentAccessPolicyV2Fields,
} from "@paperclipai/shared";

/** AgentDash: APM gate 2 (P2.3) — shared seed helpers for the V2 shadow-access suites. */

type TestDb = ReturnType<typeof createDb>;

/** Set `companies.agent_access_enforcement` directly (the route refuses `enforce` in gate 2). */
export async function setAccessMode(db: TestDb, companyId: string, mode: AgentAccessEnforcementMode) {
  await db.update(companies).set({ agentAccessEnforcement: mode }).where(eq(companies.id, companyId));
}

/**
 * Store V2 dimensions on an agent's governance sides (V1 fields = the
 * unrestricted default). `request` is the steward/accountable side, `ceiling`
 * the admin side. Replaces any existing row's sides.
 */
export async function setAccessPolicy(
  db: TestDb,
  companyId: string,
  agentId: string,
  sides: { request?: AgentAccessPolicyV2Fields; ceiling?: AgentAccessPolicyV2Fields },
) {
  const side = (v2?: AgentAccessPolicyV2Fields) =>
    v2 && Object.keys(v2).length > 0
      ? { ...DEFAULT_AGENT_GOVERNANCE_POLICY, policyVersion: AGENT_ACCESS_POLICY_VERSION, ...v2 }
      : { ...DEFAULT_AGENT_GOVERNANCE_POLICY };
  const values = {
    ownerCeiling: side(sides.ceiling),
    stewardRequest: side(sides.request),
    effectivePolicy: { ...DEFAULT_AGENT_GOVERNANCE_POLICY },
  };
  const existing = await db
    .select({ id: agentGovernancePolicies.id })
    .from(agentGovernancePolicies)
    .where(and(eq(agentGovernancePolicies.companyId, companyId), eq(agentGovernancePolicies.agentId, agentId)))
    .then((rows) => rows[0] ?? null);
  if (existing) {
    await db.update(agentGovernancePolicies).set(values).where(eq(agentGovernancePolicies.id, existing.id));
  } else {
    await db.insert(agentGovernancePolicies).values({ companyId, agentId, ...values });
  }
}

/** Every `access.would_refuse` row in the company (optionally one site), oldest first. */
export async function wouldRefuseRows(db: TestDb, companyId: string, site?: string) {
  const rows = await db
    .select()
    .from(activityLog)
    .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "access.would_refuse")))
    .orderBy(asc(activityLog.createdAt));
  return site ? rows.filter((row) => (row.details as Record<string, unknown> | null)?.site === site) : rows;
}

/** Every activity row with this action in the company, oldest first. */
export async function activityRows(db: TestDb, companyId: string, action: string) {
  return db
    .select()
    .from(activityLog)
    .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, action)))
    .orderBy(asc(activityLog.createdAt));
}
