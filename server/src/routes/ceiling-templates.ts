import { Router, type Request } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { createCeilingTemplateSchema, updateCeilingTemplateSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { accessService } from "../services/access.js";
import { logActivity } from "../services/activity-log.js";
import { requireProductProfile } from "../services/companies.js";
import { ceilingTemplateService } from "../services/ceiling-templates.js";
import { assertBoard, assertCompanyAccess, assertCompanyAdministrator, getActorInfo } from "./authz.js";

/**
 * AgentDash admin powers: ceiling templates. Reading needs company access;
 * creating, editing and deleting are owner/admin decisions. Like the agent
 * governance routes they exist only where agent ceilings do (the
 * `agentdash_mk` profile): elsewhere every route is 404, indistinguishable
 * from a company that does not exist.
 */
export function ceilingTemplateRoutes(db: Db) {
  const router = Router();
  const svc = ceilingTemplateService(db);
  const access = accessService(db);

  async function requireProfileCompany(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    const company = await db
      .select({ id: companies.id, productProfile: companies.productProfile })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    return requireProductProfile(company, "agentdash_mk");
  }

  async function requireAdmin(req: Request, companyId: string) {
    assertBoard(req);
    await requireProfileCompany(req, companyId);
    await assertCompanyAdministrator(access, req, companyId, "Only owners and admins can change ceiling templates.");
  }

  async function log(req: Request, companyId: string, action: string, templateId: string, details: Record<string, unknown>) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action,
      entityType: "ceiling_template",
      entityId: templateId,
      details,
    });
  }

  router.get("/companies/:companyId/ceiling-templates", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);
    res.json({ templates: await svc.list(companyId) });
  });

  router.post("/companies/:companyId/ceiling-templates", validate(createCeilingTemplateSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireAdmin(req, companyId);
    const template = await svc.create(companyId, { ...req.body, createdByUserId: req.actor.userId ?? null });
    await log(req, companyId, "ceiling_template.created", template.id, { name: template.name, ceiling: template.ceiling });
    res.status(201).json(template);
  });

  router.patch("/companies/:companyId/ceiling-templates/:templateId", validate(updateCeilingTemplateSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireAdmin(req, companyId);
    const { before, after } = await svc.update(companyId, req.params.templateId as string, req.body);
    await log(req, companyId, "ceiling_template.updated", after.id, {
      name: after.name,
      previousName: before.name,
      ceiling: after.ceiling,
      previousCeiling: before.ceiling,
      revision: after.revision,
    });
    res.json(after);
  });

  router.delete("/companies/:companyId/ceiling-templates/:templateId", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireAdmin(req, companyId);
    const removed = await svc.remove(companyId, req.params.templateId as string);
    await log(req, companyId, "ceiling_template.deleted", removed.id, { name: removed.name });
    res.json({ id: removed.id, deleted: true });
  });

  return router;
}
