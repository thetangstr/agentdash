import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { stewardWebhooksService } from "../services/steward-webhooks.js";

/**
 * A steward's own webhook registrations — the `me/` scoping is load-bearing,
 * exactly as it is for bridge endpoints: everything here is the signed-in
 * person registering, listing and revoking delivery FOR THEMSELVES. There is
 * deliberately no route to register a webhook for somebody else; pointing
 * another person's approvals at a channel they did not choose is the failure
 * mode, not a feature.
 */
const registerSchema = z.object({
  url: z.string().min(1).max(2000),
  label: z.string().max(120).optional(),
});

export function stewardWebhookRoutes(db: Db) {
  const router = Router();
  const webhooks = stewardWebhooksService(db);

  function requireBoardUser(req: { actor: { type: string; userId?: string | null } }): string {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw forbidden("Board user access required");
    }
    return req.actor.userId;
  }

  router.post(
    "/companies/:companyId/me/webhooks",
    validate(registerSchema),
    async (req, res) => {
      const userId = requireBoardUser(req);
      const companyId = req.params.companyId as string;
      const created = await webhooks.register({
        companyId,
        userId,
        url: String(req.body.url),
        label: String(req.body.label ?? ""),
      });
      res.status(201).json(created);
    },
  );

  router.get("/companies/:companyId/me/webhooks", async (req, res) => {
    const userId = requireBoardUser(req);
    const companyId = req.params.companyId as string;
    res.json({ webhooks: await webhooks.listForUser(companyId, userId) });
  });

  router.post("/companies/:companyId/me/webhooks/:webhookId/revoke", async (req, res) => {
    const userId = requireBoardUser(req);
    const companyId = req.params.companyId as string;
    res.json(await webhooks.revoke(companyId, userId, req.params.webhookId as string));
  });

  return router;
}
