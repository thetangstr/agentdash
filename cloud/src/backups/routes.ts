// AgentDash (GH #733): the operator routes for off-box backups, mounted under
// /internal behind the admin guard (IP allow-list and admin bearer).
//
//   GET  /internal/backups                  fleet backup status (stale flag per box)
//   GET  /internal/boxes/:slug/backups      a box's backups, newest first
//   POST /internal/boxes/:slug/backups      back the box up now (202; runs in the background)
//   GET  /internal/backups/:id/download     the encrypted object, streamed (still sealed to the offline key)
import { Router, type Router as ExpressRouter } from "express";
import { desc, eq } from "drizzle-orm";
import type { CloudDb } from "../db/client.js";
import { boxBackups, boxes } from "../db/schema.js";
import type { Logger } from "../logger.js";
import { BackupFailure, fleetBackupStatus, type BackupService } from "./service.js";
import type { ObjectStore } from "./s3.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

export interface BackupRouteDeps {
  service?: BackupService;
  store?: ObjectStore;
  staleHours: number;
  /** Shown in the status answer, e.g. the store and key id. */
  describe?: Record<string, unknown>;
}

export function backupRoutes(db: CloudDb, log: Logger, deps: BackupRouteDeps): ExpressRouter {
  const router = Router();
  const notConfigured = { error: "off-box backups are not configured (CLOUD_BACKUP_S3_*, CLOUD_BACKUP_PUBLIC_KEY)" };

  router.get("/backups", async (_req, res) => {
    const boxesStatus = await fleetBackupStatus(db, { staleHours: deps.staleHours });
    res.json({
      configured: Boolean(deps.service),
      ...(deps.describe ?? {}),
      staleHours: deps.staleHours,
      stale: boxesStatus.filter((b) => b.stale).map((b) => b.slug),
      boxes: boxesStatus,
    });
  });

  router.get("/boxes/:slug/backups", async (req, res) => {
    if (!SLUG_RE.test(req.params.slug)) return void res.status(400).json({ error: "bad slug" });
    const [box] = await db.select({ id: boxes.id }).from(boxes).where(eq(boxes.slug, req.params.slug));
    if (!box) return void res.status(404).json({ error: "no such box" });
    const rows = await db
      .select({
        id: boxBackups.id,
        trigger: boxBackups.trigger,
        backupDay: boxBackups.backupDay,
        state: boxBackups.state,
        attempt: boxBackups.attempt,
        sizeBytes: boxBackups.sizeBytes,
        plainBytes: boxBackups.plainBytes,
        sha256: boxBackups.sha256,
        sealedTo: boxBackups.sealedTo,
        release: boxBackups.release,
        counts: boxBackups.counts,
        error: boxBackups.error,
        startedAt: boxBackups.startedAt,
        finishedAt: boxBackups.finishedAt,
        prunedAt: boxBackups.prunedAt,
      })
      .from(boxBackups)
      .where(eq(boxBackups.boxId, box.id))
      .orderBy(desc(boxBackups.startedAt))
      .limit(100);
    res.json({ backups: rows });
  });

  router.post("/boxes/:slug/backups", async (req, res) => {
    if (!deps.service) return void res.status(409).json(notConfigured);
    if (!SLUG_RE.test(req.params.slug)) return void res.status(400).json({ error: "bad slug" });
    try {
      const { backupId, done } = await deps.service.runManual(req.params.slug);
      done.catch((err: unknown) => log.error("manual backup failed", { err }));
      res.status(202).json({ backupId, state: "running", next: `admin backups list ${req.params.slug}` });
    } catch (err) {
      if (err instanceof BackupFailure) return void res.status(err.reason === "box_busy" ? 409 : 400).json({ error: err.message });
      throw err;
    }
  });

  router.get("/backups/:id/download", async (req, res) => {
    if (!deps.store) return void res.status(409).json(notConfigured);
    if (!UUID_RE.test(req.params.id)) return void res.status(400).json({ error: "bad backup id" });
    const [row] = await db.select().from(boxBackups).where(eq(boxBackups.id, req.params.id));
    if (!row || row.state !== "succeeded" || !row.objectPath) return void res.status(404).json({ error: "no stored backup with that id" });
    const body = await deps.store.get(row.objectPath);
    res.status(200);
    res.setHeader("content-type", "application/octet-stream");
    if (row.sizeBytes) res.setHeader("content-length", String(row.sizeBytes));
    if (row.sha256) res.setHeader("x-agentdash-backup-sha256", row.sha256);
    body.on("error", (err) => {
      log.error("backup download stream failed", { err });
      res.destroy(err);
    });
    body.pipe(res);
  });

  return router;
}
