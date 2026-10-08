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
import { EdgeNotLive } from "../railway/edge-backfill.js";
import type { FrontDoor } from "../front-door/service.js";
import { type inviteService, parseCodeList } from "../invites.js";
import type { ReleaseResolverDeps } from "../jobs/rollout.js";
import { fleetRoutes, isBoxPurpose } from "./fleet.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

export interface InternalRouteDeps {
  /** SC-7 (GH #768): approval emails and the approved-waitlist release. */
  frontDoor?: Pick<FrontDoor, "notifyApproved" | "releaseApproved">;
  /** SC-9 (GH #770): the self-hosted invite codes. */
  invites?: ReturnType<typeof inviteService>;
  /** The fleet edge-secret back-fill (#807 review); absent without a Railway token. */
  edgeBackfill?: () => Promise<unknown>;
  /** AgentDash (SC-12, GH #773): resolving a release to its GHCR digest for rollouts and single-box upgrades. */
  fleet?: ReleaseResolverDeps;
}

export function internalRoutes(db: CloudDb, log: Logger, deps: InternalRouteDeps = {}): ExpressRouter {
  const router = Router();
  // AgentDash (SC-12 GH #773, GH #861): rollouts, single-box upgrades, hold and purpose.
  if (deps.fleet) router.use(fleetRoutes(db, log, deps.fleet));

  router.post("/fleet/edge-backfill", async (_req, res) => {
    if (!deps.edgeBackfill) {
      res.status(409).json({ error: "no Railway token configured" });
      return;
    }
    try {
      const result = await deps.edgeBackfill();
      log.info("edge secret back-fill", { result: result as Record<string, unknown> });
      res.json(result);
    } catch (err) {
      if (err instanceof EdgeNotLive) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  });
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

  router.get("/boxes", async (req, res) => {
    // AgentDash (GH #861): `boxes list --purpose demo`.
    const purpose = typeof req.query.purpose === "string" ? req.query.purpose : null;
    if (purpose !== null && !isBoxPurpose(purpose)) {
      res.status(400).json({ error: "purpose must be customer, demo, canary or internal" });
      return;
    }
    const rows = await db
      .select({
        id: boxes.id,
        slug: boxes.slug,
        kind: boxes.kind,
        purpose: boxes.purpose,
        state: boxes.state,
        planTier: boxes.planTier,
        releaseTag: boxes.releaseTag,
        holdUpgrades: boxes.holdUpgrades,
        publicUrl: boxes.publicUrl,
        claimedAt: boxes.claimedAt,
        createdAt: boxes.createdAt,
      })
      .from(boxes)
      .where(purpose ? eq(boxes.purpose, purpose) : undefined)
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

  /**
   * Approve one waiting entry: it leaves the waitlist, its box is asked for
   * provisioning (the kill switch and the daily cap still apply; if either
   * holds, the box stays waitlisted as approved-pending and the release
   * sweep picks it up later), and the person is emailed (SC-7).
   */
  async function approveEntry(id: string, ip: string | null) {
    const [row] = await db
      .update(waitlist)
      .set({ state: "approved", approvedAt: new Date(), approvedBy: "admin-cli", updatedAt: new Date() })
      .where(and(eq(waitlist.id, id), eq(waitlist.state, "waiting")))
      .returning();
    if (!row) return null;
    await db.insert(boxEvents).values({
      kind: "waitlist_approved",
      actor: "admin-cli",
      detail: { waitlistId: row.id, ip },
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
      const first = provisioning[0];
      if (deps.frontDoor && first) await deps.frontDoor.notifyApproved(row.accountId, first.slug, first.outcome === "queued");
    }
    return { waitlist: row, provisioning };
  }

  router.post("/waitlist/:id/approve", async (req, res) => {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "id must be a uuid" });
      return;
    }
    const ip = typeof res.locals.adminIp === "string" ? res.locals.adminIp : null;
    const result = await approveEntry(id, ip);
    if (!result) {
      res.status(404).json({ error: "no waiting entry with that id" });
      return;
    }
    res.json(result);
  });

  // SC-7 (GH #768): approve the oldest N waiting entries in one go (spec §5.1, "in a batch").
  router.post("/waitlist/approve-next", async (req, res) => {
    const count = Number((req.body ?? {}).count);
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      res.status(400).json({ error: "count must be an integer from 1 to 100" });
      return;
    }
    const ip = typeof res.locals.adminIp === "string" ? res.locals.adminIp : null;
    const oldest = await db.select({ id: waitlist.id }).from(waitlist).where(eq(waitlist.state, "waiting")).orderBy(waitlist.createdAt).limit(count);
    const approved = [];
    for (const { id } of oldest) {
      const r = await approveEntry(id, ip);
      if (r) approved.push(r);
    }
    res.json({ approved });
  });

  // SC-7 (GH #768): approved entries whose box still waits get their job if the gates are open now.
  router.post("/waitlist/release", async (_req, res) => {
    if (!deps.frontDoor) {
      res.status(409).json({ error: "the front door is not configured" });
      return;
    }
    res.json({ released: await deps.frontDoor.releaseApproved() });
  });

  // AgentDash (SC-9, GH #770): the self-hosted invite codes. No response ever carries a stored code;
  // `add` returns the one new code it made, once.
  const adminIp = (res: import("express").Response) => (typeof res.locals.adminIp === "string" ? res.locals.adminIp : null);
  router.get("/invites", async (_req, res) => {
    if (!deps.invites) return void res.status(409).json({ error: "invites are not configured" });
    res.json({ invites: await deps.invites.list() });
  });
  router.post("/invites/import", async (req, res) => {
    if (!deps.invites) return void res.status(409).json({ error: "invites are not configured" });
    const { codes, label, allowShort } = (req.body ?? {}) as { codes?: unknown; label?: unknown; allowShort?: unknown };
    const list = typeof codes === "string" ? parseCodeList(codes) : Array.isArray(codes) && codes.every((c) => typeof c === "string") ? parseCodeList(codes.join("\n")) : null;
    if (!list || list.length === 0 || list.length > 10_000) {
      res.status(400).json({ error: 'body must be {"codes": "<codes separated by commas or newlines>", "label"?: "..."} with 1 to 10000 codes' });
      return;
    }
    const result = await deps.invites.importCodes(list, typeof label === "string" ? label.slice(0, 120) : null, "admin-cli", adminIp(res), { allowShort: allowShort === true });
    log.info("invite codes imported", result);
    res.json(result);
  });
  router.post("/invites", async (req, res) => {
    if (!deps.invites) return void res.status(409).json({ error: "invites are not configured" });
    const label = typeof (req.body ?? {}).label === "string" ? String(req.body.label).slice(0, 120) : null;
    const result = await deps.invites.add(label, "admin-cli", adminIp(res));
    log.info("invite code added", { id: result.id });
    res.status(201).json(result);
  });
  // Explicit hosted issuance: default add/import remain reusable self-hosted codes.
  router.post("/invites/hosted", async (req, res) => {
    if (!deps.invites) return void res.status(409).json({ error: "invites are not configured" });
    const label = typeof (req.body ?? {}).label === "string" ? req.body.label.trim() : "";
    if (!label || label.length > 120) return void res.status(400).json({ error: "label must be 1-120 characters" });
    const result = await deps.invites.addHosted(label, "admin-cli", adminIp(res));
    log.info("hosted invite code added", { id: result.id });
    res.status(201).json(result);
  });
  router.post("/invites/:id/revoke", async (req, res) => {
    if (!deps.invites) return void res.status(409).json({ error: "invites are not configured" });
    if (!UUID_RE.test(req.params.id)) return void res.status(400).json({ error: "id must be a uuid" });
    if (!(await deps.invites.revoke(req.params.id, "admin-cli", adminIp(res)))) return void res.status(404).json({ error: "no live invite code with that id" });
    res.json({ id: req.params.id, revoked: true });
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
    const { slug, email, releaseTag, purpose } = (req.body ?? {}) as { slug?: unknown; email?: unknown; releaseTag?: unknown; purpose?: unknown };
    if (purpose !== undefined && purpose !== null && !isBoxPurpose(purpose)) {
      res.status(400).json({ error: "purpose must be customer, demo, canary or internal" });
      return;
    }
    if (typeof slug !== "string" || typeof email !== "string" || (releaseTag !== undefined && releaseTag !== null && typeof releaseTag !== "string")) {
      res.status(400).json({ error: 'body must be {"slug": "...", "email": "...", "releaseTag"?: "vYYYY.MDD.N"}' });
      return;
    }
    if (typeof releaseTag === "string" && !/^v\d{4}\.\d{3,4}\.\d+$/.test(releaseTag)) {
      res.status(400).json({ error: "releaseTag must look like v2026.925.0" });
      return;
    }
    try {
      const r = await createBoxForOperator(
        db,
        { slug, email, releaseTag: (releaseTag as string | undefined) ?? null, ...(isBoxPurpose(purpose) ? { purpose } : {}) },
        "admin-cli",
      );
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
