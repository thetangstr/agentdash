import { Router } from "express";
import type { Request } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import {
  createDeliverableCheckSchema,
  createDeliverableFactSchema,
  createDeliverableSchema,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { requireProductProfile } from "../services/companies.js";
import { deliverableService } from "../services/deliverables.js";
import { assertCompanyAccess } from "./authz.js";

/**
 * AgentDash-MK: the deliverable definition surface.
 *
 * **Implementer-only, deliberately.** Every write here requires instance
 * administration — the role an implementer holds while encoding one observed
 * cycle. An ordinary member of any membership role is refused, and so is an
 * agent key. That is not a permission that could be widened later without
 * changing what this product is: self-service process capture is the thing
 * with no working analogue anywhere, and every analogue that works has a third
 * party doing the encoding.
 *
 * The check-authoring route matters most. An assembling agent that could write
 * its own acceptance tests would defeat G3 at definition time, where nothing
 * downstream could see it — running the checker on a separate execution path
 * would then be theatre.
 *
 * Profile-gated: outside `agentdash_mk` every route here answers 404, so a
 * company without this feature cannot tell that someone else has it.
 */
export function deliverableRoutes(db: Db) {
  const router = Router();
  const svc = deliverableService(db);

  async function requireProfileCompany(companyId: string) {
    const company = await db
      .select({ id: companies.id, productProfile: companies.productProfile })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    return requireProductProfile(company, "agentdash_mk");
  }

  /**
   * The implementer gate.
   *
   * Checked AFTER the profile lookup so an off-profile company gets 404 rather
   * than a 403 that confirms the route exists.
   */
  function requireImplementer(req: Request): string {
    if (req.actor.type !== "board") {
      throw forbidden("Deliverables are defined by an implementer, not by an agent");
    }
    if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
      throw forbidden(
        "Deliverables and their acceptance checks are authored by an implementer; " +
          "there is no self-service authoring surface",
      );
    }
    return req.actor.userId ?? "implementer";
  }

  router.post(
    "/companies/:companyId/deliverables",
    validate(createDeliverableSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await requireProfileCompany(companyId);
      const byUserId = requireImplementer(req);
      res.status(201).json(await svc.create(companyId, req.body, byUserId));
    },
  );

  router.get("/companies/:companyId/deliverables", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(companyId);
    assertCompanyAccess(req, companyId);
    res.json({ deliverables: await svc.list(companyId) });
  });

  /**
   * The full definition, readable by anyone in the company.
   *
   * Read is not gated to implementers: the fact list is the record of how this
   * organization's numbers are made, and a record nobody may read is not a
   * record. Only authoring is restricted.
   */
  router.get("/companies/:companyId/deliverables/:key", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(companyId);
    assertCompanyAccess(req, companyId);
    res.json(await svc.detail(companyId, req.params.key as string));
  });

  router.post(
    "/companies/:companyId/deliverables/:key/facts",
    validate(createDeliverableFactSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await requireProfileCompany(companyId);
      requireImplementer(req);
      res.status(201).json(await svc.addFact(companyId, req.params.key as string, req.body));
    },
  );

  router.post(
    "/companies/:companyId/deliverables/:key/checks",
    validate(createDeliverableCheckSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await requireProfileCompany(companyId);
      requireImplementer(req);
      res.status(201).json(await svc.addCheck(companyId, req.params.key as string, req.body));
    },
  );

  return router;
}
