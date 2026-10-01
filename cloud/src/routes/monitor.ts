// AgentDash (SC-10, GH #771): the fleet monitor's operator routes, mounted
// under /internal behind the same IP allow-list and admin bearer as the rest
// of the operator surface (../app.ts). Used by the admin CLI:
//   GET  /internal/fleet/status        fleet summary (spec §6.3)
//   GET  /internal/boxes/:slug/health  one box's health, history, idle state
//   POST /internal/boxes/:slug/suspend queue a suspend job
//   POST /internal/boxes/:slug/wake    queue a resume job
//   POST /internal/alerts/test         send a test alert on every transport
//   GET  /internal/alerts              firing alerts
import { Router, type Request, type Response, type Router as ExpressRouter } from "express";
import { desc, eq } from "drizzle-orm";
import type { CloudDb } from "../db/client.js";
import { fleetAlerts } from "../db/schema.js";
import type { Alerter } from "../jobs/alerts.js";
import { BoxOpError } from "../jobs/ops.js";
import { type Logger, redactString } from "../logger.js";
import { boxHealthReport, fleetStatus, operatorSuspend, operatorWake } from "../monitor/status.js";

const SLUG_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

export interface MonitorRouteDeps {
  edgeLive: boolean;
  /** The ops transports by name ("log", "webhook", "email"); the name, never a URL or address, is reported. */
  transports: Array<{ name: string; alerter: Alerter }>;
}

export function monitorRoutes(db: CloudDb, log: Logger, deps: MonitorRouteDeps): ExpressRouter {
  const router = Router();

  router.get("/fleet/status", async (_req, res) => {
    res.json(await fleetStatus(db, { edgeLive: deps.edgeLive }));
  });

  const bySlug = (fn: (slug: string) => Promise<unknown>) => async (req: Request, res: Response) => {
    const slug = String(req.params.slug);
    if (!SLUG_RE.test(slug)) return void res.status(400).json({ error: "not a box slug" });
    try {
      res.json(await fn(slug));
    } catch (err) {
      if (err instanceof BoxOpError) return void res.status(err.status).json({ error: err.message });
      throw err;
    }
  };
  router.get("/boxes/:slug/health", bySlug((slug) => boxHealthReport(db, slug)));
  router.post(
    "/boxes/:slug/suspend",
    bySlug(async (slug) => {
      const r = await operatorSuspend(db, slug, "admin-cli");
      log.info("box suspend requested", { slug, created: r.created });
      return { slug, ...r };
    }),
  );
  router.post(
    "/boxes/:slug/wake",
    bySlug(async (slug) => {
      const r = await operatorWake(db, slug, "admin-cli");
      log.info("box wake requested", { slug, created: r.created });
      return { slug, ...r };
    }),
  );

  router.get("/alerts", async (_req, res) => {
    const rows = await db.select().from(fleetAlerts).where(eq(fleetAlerts.state, "firing")).orderBy(desc(fleetAlerts.firstFiredAt)).limit(200);
    res.json({ alerts: rows });
  });

  // Each transport is tried on its own so the operator sees which one works.
  router.post("/alerts/test", async (_req, res) => {
    const at = new Date().toISOString();
    const alert = { kind: "alert_test" as const, subject: `test alert from cloud-control at ${at}`, detail: "sent by `admin alerts test`; no action needed" };
    const results = await Promise.all(
      deps.transports.map(async (t) => {
        try {
          await t.alerter.send(alert);
          return { transport: t.name, ok: true };
        } catch (err) {
          return { transport: t.name, ok: false, error: redactString(err instanceof Error ? err.message : String(err)) };
        }
      }),
    );
    log.info("test alert sent", { results });
    res.status(results.every((r) => r.ok) ? 200 : 502).json({ at, results });
  });

  return router;
}
