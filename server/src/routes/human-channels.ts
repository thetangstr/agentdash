import { Router } from "express";
import type { Request } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { verifyHumanChannelBindingSchema } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService } from "../services/access.js";
import { requireProductProfile } from "../services/companies.js";
import { humanChannelService } from "../services/human-channels.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function humanChannelRoutes(db: Db) {
  const router = Router();
  const channels = humanChannelService(db);
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

  function requireBoardUser(req: Request) {
    assertBoard(req);
    if (!req.actor.userId) throw forbidden("Board user access required");
    return req.actor.userId;
  }

  async function isAdministrator(req: Request, companyId: string) {
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
    return access.canUser(companyId, req.actor.userId, "agents:create");
  }

  /** A human's own bindings. Identity comes from the session, never the body. */
  router.get("/companies/:companyId/me/channels", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);
    const userId = requireBoardUser(req);
    const all = await channels.listForCompany(companyId);
    res.json({ bindings: all.filter((binding) => binding.userId === userId) });
  });

  /**
   * Complete a pairing. The provider identity is supplied, but WHO it binds to
   * is always the authenticated caller — accepting a userId here would let one
   * member attach a provider account to someone else's agent.
   */
  router.post(
    "/companies/:companyId/me/channels",
    validate(verifyHumanChannelBindingSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await requireProfileCompany(req, companyId);
      const userId = requireBoardUser(req);

      const binding = await channels.verifyBinding(companyId, {
        provider: req.body.provider,
        userId,
        externalTenantId: req.body.externalTenantId ?? null,
        externalUserId: req.body.externalUserId,
        externalConversationId: req.body.externalConversationId ?? null,
        metadata: req.body.metadata ?? null,
      });
      res.status(201).json({ binding });
    },
  );

  /** A human may revoke their own binding; an administrator may revoke any. */
  router.post("/companies/:companyId/channel-bindings/:bindingId/revoke", async (req, res) => {
    const companyId = req.params.companyId as string;
    const bindingId = req.params.bindingId as string;
    await requireProfileCompany(req, companyId);
    const userId = requireBoardUser(req);

    const existing = (await channels.listForCompany(companyId)).find(
      (binding) => binding.id === bindingId,
    );
    if (existing && existing.userId !== userId && !(await isAdministrator(req, companyId))) {
      throw forbidden("Only the bound user or an administrator can revoke this binding");
    }

    res.json({ binding: await channels.revokeBinding(companyId, bindingId, { actorUserId: userId }) });
  });

  /** Administrator view of every binding in the company, for audit. */
  router.get("/companies/:companyId/channel-bindings", async (req, res) => {
    const companyId = req.params.companyId as string;
    await requireProfileCompany(req, companyId);
    requireBoardUser(req);
    if (!(await isAdministrator(req, companyId))) {
      throw forbidden("Listing company channel bindings requires administrator access");
    }
    res.json({ bindings: await channels.listForCompany(companyId) });
  });

  return router;
}
