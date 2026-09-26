// AgentDash: the operator surface (spec §3.6). Reached only by the admin CLI:
// every route sits behind the IP allow-list AND the admin bearer (see
// ../auth.ts). Public routes (signup, verify, …) are added by later issues and
// never mount under /internal.
import { Router, type Router as ExpressRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import type { CloudDb } from "../db/client.js";
import { boxEvents, boxes, JOB_STATES, jobs, waitlist, type JobState } from "../db/schema.js";
import { abandonBox, BoxOpError, createBoxForOperator, retryBox } from "../jobs/ops.js";
import { requestProvision } from "../jobs/queue.js";
import type { Logger } from "../logger.js";
import { isSettingKey, SettingValidationError, settingsService } from "../settings.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

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
      const ip = typeof res.locals.adminIp === "string" ? res.locals.adminIp : null;
      const value = await svc.set(key, req.body.value, "admin-cli", { ip });
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
    // AgentDash (GH #764): approval takes the box off the waitlist. The kill
    // switch and the daily cap still apply; if either holds, it stays waitlisted.
    const provisioning: Array<{ slug: string; outcome: string; reason?: string }> = [];
    if (row.accountId) {
      const waiting = await db
        .select({ id: boxes.id, slug: boxes.slug })
        .from(boxes)
        .where(and(eq(boxes.accountId, row.accountId), eq(boxes.state, "waitlisted")));
      for (const b of waiting) {
        const r = await requestProvision(db, b.id, { actor: "admin-cli", approved: true });
        provisioning.push({ slug: b.slug, outcome: r.outcome, ...(r.outcome === "waitlisted" ? { reason: r.reason } : {}) });
      }
    }
    res.json({ waitlist: row, provisioning });
  });

  // AgentDash (GH #764): the job queue and the failed-box actions.
  router.get("/jobs", async (req, res) => {
    const state = typeof req.query.state === "string" ? req.query.state : "all";
    if (state !== "all" && !(JOB_STATES as readonly string[]).includes(state)) {
      res.status(400).json({ error: `state must be all or one of ${JOB_STATES.join(", ")}` });
      return;
    }
    const rows = await db
      .select({
        id: jobs.id,
        slug: boxes.slug,
        kind: jobs.kind,
        state: jobs.state,
        step: jobs.step,
        attempt: jobs.attempt,
        runAfter: jobs.runAfter,
        lockedBy: jobs.lockedBy,
        lastError: jobs.lastError,
        createdAt: jobs.createdAt,
      })
      .from(jobs)
      .innerJoin(boxes, eq(boxes.id, jobs.boxId))
      .where(state === "all" ? undefined : eq(jobs.state, state as JobState))
      .orderBy(desc(jobs.createdAt))
      .limit(500);
    res.json({ jobs: rows });
  });

  const boxOp = (op: (db: CloudDb, slug: string, actor: string) => Promise<unknown>, label: string) =>
    async (req: import("express").Request, res: import("express").Response) => {
      const slug = String(req.params.slug);
      if (!SLUG_RE.test(slug)) {
        res.status(400).json({ error: "not a box slug" });
        return;
      }
      try {
        const result = await op(db, slug, "admin-cli");
        log.info(`box ${label}`, { slug });
        res.json({ slug, ...(result as object) });
      } catch (err) {
        if (err instanceof BoxOpError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        throw err;
      }
    };
  // AgentDash (GH #763): an operator-created box, provisioned under the same kill switch and daily cap.
  router.post("/boxes", async (req, res) => {
    const { slug, email, releaseTag } = (req.body ?? {}) as { slug?: unknown; email?: unknown; releaseTag?: unknown };
    if (typeof slug !== "string" || typeof email !== "string" || (releaseTag !== undefined && releaseTag !== null && typeof releaseTag !== "string")) {
      res.status(400).json({ error: 'body must be {"slug": "...", "email": "...", "releaseTag"?: "vYYYY.MDD.N"}' });
      return;
    }
    if (typeof releaseTag === "string" && !/^v\d{4}\.\d{3,4}\.\d+$/.test(releaseTag)) {
      res.status(400).json({ error: "releaseTag must look like v2026.925.0" });
      return;
    }
    try {
      const r = await createBoxForOperator(db, { slug, email, releaseTag: (releaseTag as string | undefined) ?? null }, "admin-cli");
      log.info("box created by operator", { slug, outcome: r.provisioning.outcome });
      res.status(201).json({ slug, ...r });
    } catch (err) {
      if (err instanceof BoxOpError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  });
  router.post("/boxes/:slug/retry", boxOp(retryBox, "retry"));
  router.post("/boxes/:slug/abandon", boxOp(abandonBox, "abandon"));

  return router;
}
