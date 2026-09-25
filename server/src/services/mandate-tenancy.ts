import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, mandates } from "@paperclipai/db";
import { notFound } from "../errors.js";

type MandateRow = typeof mandates.$inferSelect;

// AgentDash (security): tenant binding for mandates.
//
// Mandates, and the agents they name, are addressed by global ids. Every path
// that evaluates a mandate or acts on an agent it names must first prove that
// the mandate, its grantor, its grantee, and any caller-supplied agent id all
// belong to the company in the route. Without this, an admin of company A could
// name company B's agent (or B's mandate) and have enforcement pause it.
//
// Failures are a 404 on purpose: a cross-company id and a nonexistent id must be
// indistinguishable, or the endpoint becomes an existence oracle.
export function mandateTenancy(db: Db) {
  async function assertAgentsInCompany(companyId: string, agentIds: readonly string[]): Promise<void> {
    const ids = [...new Set(agentIds.filter((id): id is string => typeof id === "string" && id.length > 0))];
    if (ids.length === 0) return;
    const rows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(inArray(agents.id, ids), eq(agents.companyId, companyId)));
    if (rows.length !== ids.length) throw notFound("Agent not found");
  }

  /**
   * Load a mandate only if it, its grantor, its grantee, and every extra agent
   * id supplied belong to `companyId`. Throws 404 otherwise.
   */
  async function loadMandateInCompany(
    companyId: string,
    mandateId: string,
    extraAgentIds: readonly (string | undefined | null)[] = [],
  ): Promise<MandateRow> {
    const [row] = await db
      .select()
      .from(mandates)
      .where(and(eq(mandates.id, mandateId), eq(mandates.companyId, companyId)));
    if (!row) throw notFound("Mandate not found");
    try {
      await assertAgentsInCompany(companyId, [
        row.grantorAgentId,
        row.granteeAgentId,
        ...extraAgentIds.filter((id): id is string => typeof id === "string"),
      ]);
    } catch {
      throw notFound("Mandate not found");
    }
    return row;
  }

  return { assertAgentsInCompany, loadMandateInCompany };
}

export type MandateTenancy = ReturnType<typeof mandateTenancy>;
