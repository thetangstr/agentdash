import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentCeilingTemplates, companies } from "@paperclipai/db";
import { normalizeAgentGovernancePolicy, type AgentGovernancePolicy } from "@paperclipai/shared";
import { conflict, notFound } from "../errors.js";
import { isUniqueViolation } from "../lib/pg-error.js";

/**
 * AgentDash admin powers: ceiling templates — a named owner ceiling an admin
 * defines once, applies to many agents (batch kind `agent.apply_ceiling`) or
 * makes the ceiling for every new agent (`companies.default_ceiling_template_id`).
 * Every read and write is scoped to one company: a template id from another
 * company is "not found".
 */

export type CeilingTemplateRow = typeof agentCeilingTemplates.$inferSelect;

export function ceilingTemplateService(db: Db) {
  async function get(companyId: string, templateId: string): Promise<CeilingTemplateRow | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(templateId)) return null;
    const [row] = await db
      .select()
      .from(agentCeilingTemplates)
      .where(and(eq(agentCeilingTemplates.id, templateId), eq(agentCeilingTemplates.companyId, companyId)));
    return row ?? null;
  }

  return {
    get,
    list: (companyId: string) =>
      db.select().from(agentCeilingTemplates).where(eq(agentCeilingTemplates.companyId, companyId)).orderBy(asc(agentCeilingTemplates.name)),

    async create(companyId: string, input: { name: string; ceiling: AgentGovernancePolicy; createdByUserId: string | null }) {
      try {
        const [row] = await db.insert(agentCeilingTemplates).values({
          companyId,
          name: input.name.trim(),
          ceiling: normalizeAgentGovernancePolicy(input.ceiling),
          createdByUserId: input.createdByUserId,
        }).returning();
        return row!;
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict("A ceiling template with this name already exists.");
        throw error;
      }
    },

    async update(companyId: string, templateId: string, input: { name?: string; ceiling?: AgentGovernancePolicy; revision: number }) {
      const existing = await get(companyId, templateId);
      if (!existing) throw notFound("Ceiling template not found");
      if (existing.revision !== input.revision) {
        throw conflict("This template changed since you opened it. Reload it and try again.", { currentRevision: existing.revision });
      }
      try {
        const [row] = await db
          .update(agentCeilingTemplates)
          .set({
            ...(input.name !== undefined ? { name: input.name.trim() } : {}),
            ...(input.ceiling !== undefined ? { ceiling: normalizeAgentGovernancePolicy(input.ceiling) } : {}),
            revision: existing.revision + 1,
            updatedAt: new Date(),
          })
          .where(and(eq(agentCeilingTemplates.id, templateId), eq(agentCeilingTemplates.companyId, companyId), eq(agentCeilingTemplates.revision, input.revision)))
          .returning();
        if (!row) throw conflict("This template changed since you opened it. Reload it and try again.");
        return { before: existing, after: row };
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict("A ceiling template with this name already exists.");
        throw error;
      }
    },

    /**
     * Refused while the template is the company's ceiling for new agents: the
     * admin chooses another (or none) first, so a default never vanishes
     * silently.
     */
    async remove(companyId: string, templateId: string) {
      const existing = await get(companyId, templateId);
      if (!existing) throw notFound("Ceiling template not found");
      const [company] = await db.select({ defaultCeilingTemplateId: companies.defaultCeilingTemplateId }).from(companies).where(eq(companies.id, companyId));
      if (company?.defaultCeilingTemplateId === templateId) {
        throw conflict("This template is the ceiling for new agents. Choose another one, or none, in Admin powers before deleting it.");
      }
      const [row] = await db
        .delete(agentCeilingTemplates)
        .where(and(eq(agentCeilingTemplates.id, templateId), eq(agentCeilingTemplates.companyId, companyId)))
        .returning();
      return row ?? existing;
    },
  };
}
