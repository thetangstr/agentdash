import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  isInboxEmailConfigured,
  readInboxEmailPreference,
  writeInboxEmailPreference,
} from "../services/steward-inbox-email.js";
import { assertBoard } from "./authz.js";

const updateSchema = z.object({ inboxEmail: z.boolean() }).strict();

/**
 * AgentDash: the signed-in person's own notification choices. `me` only:
 * nobody sets another person's email preference.
 */
export function notificationPreferenceRoutes(db: Db) {
  const router = Router();

  function requireSelf(req: Parameters<typeof assertBoard>[0]) {
    assertBoard(req);
    // An assistant grant acts for a person in one company; it does not get to
    // change how that person is contacted.
    if (!req.actor.userId || req.actor.source === "assistant_grant") throw forbidden("Board user context required");
    return req.actor.userId;
  }

  router.get("/notification-preferences/me", async (req, res) => {
    const userId = requireSelf(req);
    res.json({
      inboxEmail: await readInboxEmailPreference(db, userId),
      // So the page can say emails are off instance-wide rather than imply
      // the toggle does something it cannot.
      emailConfigured: isInboxEmailConfigured(),
    });
  });

  router.put("/notification-preferences/me", validate(updateSchema), async (req, res) => {
    const userId = requireSelf(req);
    const inboxEmail = await writeInboxEmailPreference(db, userId, req.body.inboxEmail);
    res.json({ inboxEmail, emailConfigured: isInboxEmailConfigured() });
  });

  return router;
}
