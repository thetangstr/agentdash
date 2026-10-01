// AgentDash: the cloud-control HTTP app. Public surface in SC-1 is only
// GET /health; the operator surface is /internal/* (see auth.ts).
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { sql } from "drizzle-orm";
import type { CloudConfig } from "./config.js";
import type { CloudDb } from "./db/client.js";
import { type Refusal, requireAdmin, type RequireAdminOptions } from "./auth.js";
import { operatorAudit } from "./db/schema.js";
import type { Logger } from "./logger.js";
import { internalRoutes } from "./routes/internal.js";
import { backfillEdgeSecrets } from "./railway/edge-backfill.js";
import { RailwayClient } from "./railway/client.js";
import { frontDoor as makeFrontDoor, type FrontDoor } from "./front-door/service.js";
import { logMailer, type Mailer, resendMailer, unconfiguredMailer } from "./front-door/mailer.js";
import { publicRoutes } from "./routes/public.js";
import { inviteService, inviteValidateRoutes } from "./invites.js";
import { type Alerter, logAlerter } from "./jobs/alerts.js";
import { monitorRoutes } from "./routes/monitor.js";

/** The front door's mail transport from config (SC-7, GH #768). */
export function mailerFromConfig(config: CloudConfig, log: Logger): Mailer {
  if (config.frontDoor.mailTransport === "log") return logMailer(log);
  if (!config.resendApiKey) return unconfiguredMailer();
  return resendMailer({ apiKey: config.resendApiKey, from: config.frontDoor.mailFrom });
}

export function createApp(opts: {
  db: CloudDb;
  config: CloudConfig;
  log: Logger;
  /** Test hooks for the operator guard (limiter, audit cap, clock). */
  admin?: Omit<RequireAdminOptions, "onRefused">;
  /** SC-7 (GH #768): the front door; built from config when omitted. Tests pass one with fakes. */
  frontDoor?: FrontDoor;
  /** SC-10 (GH #771): the ops alert transports by name, for `alerts test`. Defaults to the log. */
  alertTransports?: Array<{ name: string; alerter: Alerter }>;
}): Express {
  const { db, config, log } = opts;
  const frontDoor = opts.frontDoor ?? makeFrontDoor({ db, log, config, mailer: mailerFromConfig(config, log) });
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));

  app.get("/health", async (_req, res) => {
    try {
      await db.execute(sql`select 1`);
      res.json({ status: "ok", service: "cloud-control", release: config.release, db: "ok" });
    } catch (err) {
      log.error("health: database unreachable", { err });
      res.status(503).json({ status: "degraded", service: "cloud-control", release: config.release, db: "down" });
    }
  });

  // AgentDash (SC-7, GH #768): the public front door, reached through www's /api/cloud rewrite.
  app.use("/api/cloud", publicRoutes({ frontDoor, config }));
  // AgentDash (SC-9, GH #770): the self-hosted invite validator, reached through www's rewrite.
  app.use("/api", inviteValidateRoutes({ db, log, config }));
  // Every other /api path on www used to reach the old shared instance; it is gone (spec §7 step 2).
  app.use("/api", (_req, res) => {
    res.status(410).json({ error: "gone", message: "This API moved. Hosted workspaces live at https://<name>.agentdash.cloud; find yours at https://www.agentdash.cloud/find." });
  });

  // Refused operator requests are audited (append-only table, GH #778). No
  // credential is ever part of a Refusal.
  const onRefused = async (r: Refusal) => {
    await db.insert(operatorAudit).values({
      kind: "admin_refused",
      actor: "unauthenticated",
      ip: r.ip,
      detail: { reason: r.reason, socketIp: r.socketIp, method: r.method, path: r.path, failures: r.failures ?? null },
    });
  };
  app.use("/internal", requireAdmin(config, log, { onRefused, ...opts.admin }), internalRoutes(db, log, {
    frontDoor,
    invites: inviteService(db, config.dataKeys),
    // AgentDash (SC-12, GH #773): rollouts resolve the release's GHCR digest.
    fleet: { imageRepo: config.boxImageRepo, sourceRepo: config.boxSourceRepo },
    // AgentDash (#807 review): the fleet step for when the edge router goes live.
    ...(config.railwayToken && config.railwayWorkspaceId
      ? {
          edgeBackfill: () =>
            backfillEdgeSecrets(db, {
              client: new RailwayClient({ token: config.railwayToken!, log }),
              workspaceId: config.railwayWorkspaceId!,
              dataKeys: config.dataKeys,
              edgeLive: config.edgeLive,
              log,
            }),
        }
      : {}),
  }), // AgentDash (SC-10, GH #771): fleet status, box health, suspend and wake, alerts test.
  monitorRoutes(db, log, { edgeLive: config.edgeLive, transports: opts.alertTransports ?? [{ name: "log", alerter: logAlerter(log) }] }));

  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  // Errors never echo internals to the caller; the log line is redacted.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if ((err as { type?: string }).type === "entity.parse.failed" || (err as { type?: string }).type === "entity.too.large") {
      if (!res.headersSent) res.status(400).json({ error: "bad request body" });
      return;
    }
    log.error("request failed", { err, path: req.path, method: req.method });
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  });

  return app;
}
