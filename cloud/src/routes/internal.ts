// AgentDash: the operator surface (spec §3.6). Reached only by the admin CLI:
// every route sits behind the IP allow-list AND the admin bearer (see
// ../auth.ts). Public routes (signup, verify, …) are added by later issues and
// never mount under /internal.
import { Router, type Router as ExpressRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import type { CloudDb } from "../db/client.js";
import { boxEvents, boxes, waitlist } from "../db/schema.js";
import type { Logger } from "../logger.js";
import { isSettingKey, SettingValidationError, settingsService } from "../settings.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function internalRoutes(db: CloudDb, log: Logger): ExpressRouter {
  const router = Router();
  const svc = settingsService(db);

  router.get("/settings", async (_req, res) => {
    res.json(await svc.getAll());
  });

  router.get("/settings/:key", async (req, res) => {
    const { key } = req.params;
    if (!isSettingKey(key)) {
      res.status(404).json({ error: "unknown setting" });
      return;
    }
    res.json({ key, value: await svc.get(key) });
  });

  router.put("/settings/:key", async (req, res) => {
    const { key } = req.params;
    if (!isSettingKey(key)) {
      res.status(404).json({ error: "unknown setting" });
      return;
    }
    if (!req.body || !("value" in req.body)) {
      res.status(400).json({ error: "body must be {\"value\": …}" });
      return;
    }
    try {
      const value = await svc.set(key, req.body.value, "admin-cli");
      log.info("setting changed", { setting: key, value });
      res.json({ key, value });
    } catch (err) {
      if (err instanceof SettingValidationError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  router.get("/boxes", async (_req, res) => {
    const rows = await db
      .select({
        id: boxes.id,
        slug: boxes.slug,
        kind: boxes.kind,
        state: boxes.state,
        planTier: boxes.planTier,
        releaseTag: boxes.releaseTag,
        publicUrl: boxes.publicUrl,
        claimedAt: boxes.claimedAt,
        createdAt: boxes.createdAt,
      })
      .from(boxes)
      .orderBy(desc(boxes.createdAt))
      .limit(500);
    res.json({ boxes: rows });
  });

  router.get("/waitlist", async (req, res) => {
    const state = typeof req.query.state === "string" ? req.query.state : "waiting";
    const rows = await db
      .select()
      .from(waitlist)
      .where(state === "all" ? undefined : eq(waitlist.state, state as "waiting"))
      .orderBy(waitlist.createdAt)
      .limit(500);
    res.json({ waitlist: rows });
  });

  router.post("/waitlist/:id/approve", async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "id must be a uuid" });
      return;
    }
    const [row] = await db
      .update(waitlist)
      .set({ state: "approved", approvedAt: new Date(), approvedBy: "admin-cli", updatedAt: new Date() })
      .where(and(eq(waitlist.id, id), eq(waitlist.state, "waiting")))
      .returning();
    if (!row) {
      res.status(404).json({ error: "no waiting entry with that id" });
      return;
    }
    await db.insert(boxEvents).values({
      kind: "waitlist_approved",
      actor: "admin-cli",
      detail: { waitlistId: row.id },
    });
    log.info("waitlist entry approved", { waitlistId: row.id });
    res.json({ waitlist: row });
  });

  return router;
}
