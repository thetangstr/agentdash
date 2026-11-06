// AgentDash: guide inclusion is bound to the protected registry, not editable identity fields.
import { agents, fredRegistrations, type Db } from "@paperclipai/db";
import { and, eq, ne, sql } from "drizzle-orm";

/** Authoritative worker headcount for every tier-capacity consuming path. */
export async function countBillableAgents(db: Db, companyId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agents)
    .where(and(
      eq(agents.companyId, companyId),
      ne(agents.status, "terminated"),
      sql`not exists (select 1 from ${fredRegistrations} where ${fredRegistrations.agentId} = ${agents.id} and ${fredRegistrations.companyId} = ${agents.companyId})`,
    ));
  return rows[0]?.count ?? 0;
}
